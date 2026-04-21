/**
 * V→J 代理店コード変更に伴う過去注文データ復旧スクリプト
 *
 * 背景:
 *   旧Vコードから J0016〜J0022 へ代理店コードを変更。
 *   Bカート会員マスタは更新済みだが、Bカート過去注文の customer_parent_id は
 *   注文時点の値（V コード or 空）のまま残っている。
 *   結果、Firestore orders.dealerCode と /dealer 集計が過去注文を取りこぼす。
 *
 * 方針（確認済み・2026-04-21）:
 *   - 会員マスタの current parent_id を source of truth とする（A1）
 *   - Firestore orders.dealerCode のみ書き換え、Bカート側は触らない（B）
 *   - aggregate-dealer-monthly.mjs 側も customer_id 経由の解決に恒久対策（C、別コミット）
 *
 * 対象:
 *   期間: FROM_DATE 〜 TO_DATE（既定 2026-01-01 〜 2026-04-21）
 *   J コード: TARGET_JCODES（既定 J0016〜J0022）
 *
 * 使用方法:
 *   # dry-run（JSON ログのみ出力、書き込みなし）
 *   node scripts/rescue-v-to-j-dealers.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false OPERATOR="社長 ボンバー" node scripts/rescue-v-to-j-dealers.mjs
 *
 *   # 期間変更
 *   FROM_DATE=2026-01-01 TO_DATE=2026-04-21 node scripts/rescue-v-to-j-dealers.mjs
 *
 * 出力:
 *   - 標準出力: サマリ（期間、対象件数、代理店別件数）
 *   - scripts/logs/rescue-v-to-j-<timestamp>.json: 全件詳細（reason / willUpdate 付き）
 *   - Firestore ordersBackfillLogs/{auto-id} （production 時のみ、type: 'v-to-j-rescue'）
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken, loadAdminCredential } from './_env.mjs'

// scripts ディレクトリ絶対パス（_env.mjs に渡す）
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

// 本番 projectId 検証付きで service account を読み込み
// （test 用 credential で本番想定スクリプトが動く事故を防ぐ）
const { serviceAccount, projectId, credentialPath } = loadAdminCredential(SCRIPTS_DIR)

initializeApp({
  credential: cert(serviceAccount),
  projectId, // 明示指定で db.app.options.projectId にも反映
})
const db = getFirestore()

const SERVICE_ACCOUNT_PROJECT_ID = projectId
const SERVICE_ACCOUNT_EMAIL = serviceAccount.client_email || '(unknown)'
const CREDENTIAL_PATH_DISPLAY = credentialPath

const BCART_TOKEN = getBcartToken()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const FROM_DATE = process.env.FROM_DATE || '2026-01-01'
const TO_DATE = process.env.TO_DATE || '2026-04-21'

const TARGET_JCODES = new Set(
  (process.env.TARGET_JCODES || 'J0016,J0017,J0018,J0019,J0020,J0021,J0022')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

const BATCH_SIZE = 400
const BCART_PAGE = 100

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = `${__dirname}/logs`

// ========================================
// Bcart API helpers
// ========================================
async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  for (let retry = 0; retry < 5; retry++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${BCART_TOKEN}` },
    })
    if (res.status === 429) {
      const wait = (retry + 1) * 3000
      console.log(`   ⏳ レート制限 → ${wait / 1000}秒待機...`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new Error(`Bカート API error: ${res.status} ${res.statusText}`)
    return res.json()
  }
  throw new Error('Bカート レート制限継続中。時間をおいて再実行してください。')
}

async function fetchAllBcartCustomers() {
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('customers', { limit: BCART_PAGE, offset })
    const items = data.customers || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    process.stdout.write(`\r  Bカート 会員: ${all.length}/${total} 件`)
    if (all.length >= total) break
    offset += BCART_PAGE
  }
  process.stdout.write('\n')
  return all
}

async function fetchBcartOrdersForMonth(ym) {
  const [yy, mm] = ym.split('-')
  const lastDay = new Date(Number(yy), Number(mm), 0).getDate()
  const from = `${yy}-${mm}-01 00:00:00`
  const to = `${yy}-${mm}-${String(lastDay).padStart(2, '0')} 23:59:59`
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('orders', {
      limit: BCART_PAGE,
      offset,
      ordered_at__gte: from,
      ordered_at__lte: to,
    })
    const items = data.orders || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    if (all.length >= total) break
    offset += BCART_PAGE
  }
  return all
}

function enumerateMonths(fromDate, toDate) {
  const [fy, fm] = fromDate.split('-').slice(0, 2).map(Number)
  const [ty, tm] = toDate.split('-').slice(0, 2).map(Number)
  const out = []
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

function parentIdOf(rec) {
  return String(rec?.parent_id ?? rec?.customer_parent_id ?? rec?.parent_member_id ?? '').trim()
}

// ========================================
// main
// ========================================
async function main() {
  console.log('=== V→J 過去注文復旧スクリプト ===')
  console.log(`モード   : ${DRY_RUN ? '🟡 DRY RUN（書き込みなし）' : '🔴 本番実行'}`)
  console.log(`OPERATOR : ${OPERATOR}`)
  console.log(`対象期間 : ${FROM_DATE} 〜 ${TO_DATE}`)
  console.log(`対象Jコード: ${[...TARGET_JCODES].join(', ')}`)
  console.log('')
  console.log('▶ Firebase 接続診断')
  console.log(`  credential path                : ${CREDENTIAL_PATH_DISPLAY}`)
  console.log(`  service-account.json projectId : ${SERVICE_ACCOUNT_PROJECT_ID}`)
  console.log(`  service-account.json client_email: ${SERVICE_ACCOUNT_EMAIL}`)
  console.log(`  Firestore app projectId        : ${db.app?.options?.projectId || '(unknown)'}`)

  // Firestore 接続診断: 既知コレクションの件数を取得して接続が活きていることを確認
  const probeCollections = ['orders', 'allowedEmails', 'dealerSalons', 'dealerMonthlySnapshots']
  for (const name of probeCollections) {
    try {
      const aggSnap = await db.collection(name).count().get()
      const count = aggSnap.data().count
      console.log(`  collection '${name}': ${count} 件`)
    } catch (err) {
      // count() が使えない環境向けのフォールバック
      try {
        const sampleSnap = await db.collection(name).limit(1).get()
        console.log(`  collection '${name}': 件数取得失敗 / sample ${sampleSnap.size} 件 (count error: ${err.message})`)
      } catch (innerErr) {
        console.log(`  collection '${name}': 取得不能 (${innerErr.message})`)
      }
    }
  }
  console.log('')

  // 1. Bcart 会員マスタ取得 → customerId → current parent_id マップ
  console.log('▶ Bカート 会員一覧取得中...')
  const allCustomers = await fetchAllBcartCustomers()
  const parentByCustomerId = new Map()
  const customerMetaById = new Map()
  for (const c of allCustomers) {
    const id = String(c.id ?? '')
    if (!id) continue
    parentByCustomerId.set(id, parentIdOf(c))
    customerMetaById.set(id, {
      compName: (c.comp_name || c.customer_comp_name || c.name || '').trim(),
    })
  }
  console.log(`  総会員数: ${allCustomers.length} 件`)
  console.log('')

  // 2. Firestore orders 取得 → bcartOrderId / bcartOrderNumber でルックアップマップ構築
  //    Admin SDK は Firestore の rules を bypass するため、コレクションが存在し
  //    ドキュメントがあれば必ず取得できる。0 件なら project 違いか rules ではなく
  //    実際にコレクションが空であることを意味する。
  console.log('▶ Firestore orders 取得中...')
  const fsSnap = await db.collection('orders').get()
  const fsById = new Map()
  const fsByCode = new Map()
  let withBcartId = 0
  let withBcartCode = 0
  let withDealerCode = 0
  fsSnap.forEach((d) => {
    const data = d.data()
    if (data.bcartOrderId != null) {
      fsById.set(String(data.bcartOrderId), { docId: d.id, data })
      withBcartId += 1
    }
    if (data.bcartOrderNumber) {
      fsByCode.set(String(data.bcartOrderNumber), { docId: d.id, data })
      withBcartCode += 1
    }
    if (data.dealerCode !== undefined) withDealerCode += 1
  })
  console.log(`  Firestore orders 総件数: ${fsSnap.size} 件`)
  console.log(`    bcartOrderId 付き  : ${withBcartId} 件`)
  console.log(`    bcartOrderNumber 付き: ${withBcartCode} 件`)
  console.log(`    dealerCode フィールド付き: ${withDealerCode} 件`)

  if (fsSnap.size === 0) {
    console.log('')
    console.error('❌ Firestore の orders コレクションが 0 件です。以下を確認してください:')
    console.error(`   1) service-account.json の projectId は本番と一致しているか? (${SERVICE_ACCOUNT_PROJECT_ID})`)
    console.error('   2) Firebase Console → Firestore で orders コレクションが見えるか?')
    console.error('   3) backfill-dealer-code.mjs と同じ scripts/service-account.json を使っているか?')
    console.error('   この状態では復旧対象を特定できないため終了します。')
    process.exit(1)
  }
  console.log('')

  // 3. Bcart 受注取得（対象期間）
  console.log(`▶ Bカート 受注取得（${FROM_DATE} 〜 ${TO_DATE}）...`)
  const months = enumerateMonths(FROM_DATE, TO_DATE)
  const allOrdersRaw = []
  for (const ym of months) {
    const list = await fetchBcartOrdersForMonth(ym)
    allOrdersRaw.push(...list)
    console.log(`  ${ym}: ${list.length} 件`)
  }
  // 期間でフィルタ（月跨ぎで過剰取得分を除外）
  const inRange = allOrdersRaw.filter((o) => {
    const d = String(o.ordered_at || '').slice(0, 10)
    return d >= FROM_DATE && d <= TO_DATE
  })
  console.log(`  合計（期間内）: ${inRange.length} 件`)
  console.log('')

  // 4. 各注文を分類
  //   entries: 会員の current parent_id が対象 J コードに属する注文（復旧候補）
  //   unresolved: 会員未発見 or 対象外 J コードだが captured が V/空 の注文（要確認）
  const entries = []
  const unresolved = []

  for (const o of inRange) {
    const captured = parentIdOf(o) || ''
    const customerId = String(o.customer_id ?? '')
    const current = parentByCustomerId.get(customerId) || ''
    const customerMeta = customerMetaById.get(customerId) || null

    const base = {
      orderId: String(o.id ?? ''),
      orderNo: String(o.order_no || o.order_number || o.code || ''),
      orderedAt: o.ordered_at,
      companyName:
        (o.customer_comp_name || o.comp_name || o.customer_name || customerMeta?.compName || '').trim(),
      customerId,
      capturedParent: captured || '(空)',
      currentParent: current || '(解決不能)',
    }

    if (!current) {
      // 会員マスタで parent 解決できず
      const capturedLooksStale = !captured || captured.startsWith('V')
      if (capturedLooksStale) {
        unresolved.push({ ...base, reason: '会員マスタで parent_id を解決できない（会員削除 or customer_id 欠損）' })
      }
      continue
    }

    if (!TARGET_JCODES.has(current)) {
      // 対象 J コード外
      const capturedLooksStale = !captured || captured.startsWith('V')
      if (capturedLooksStale) {
        unresolved.push({ ...base, reason: `current parent=${current} は対象 J コード外` })
      }
      continue
    }

    // ここから対象（current ∈ TARGET_JCODES）
    const fsMatch = fsById.get(String(o.id)) || fsByCode.get(String(o.order_no || o.code || ''))
    const fsDocId = fsMatch?.docId || null
    const fsDealerCode = fsMatch?.data?.dealerCode ?? null

    const needsFirestoreUpdate = !!fsDocId && fsDealerCode !== current
    const capturedMismatch = captured !== current

    // reason 文字列（人間が読むため）
    const reasonParts = []
    if (capturedMismatch) {
      reasonParts.push(`captured=${captured || '(空)'} → current=${current}`)
    }
    if (needsFirestoreUpdate) {
      reasonParts.push(`Firestore dealerCode=${fsDealerCode ?? '(未設定)'} → ${current}`)
    } else if (!fsDocId) {
      reasonParts.push('Firestore 未取り込み（bcart-sync 実行推奨）')
    } else {
      reasonParts.push('Firestore 既に正しい')
    }

    entries.push({
      ...base,
      firestoreDocId: fsDocId,
      firestoreCurrentDealerCode: fsDealerCode,
      reason: reasonParts.join(' / '),
      willUpdate: needsFirestoreUpdate,
    })
  }

  // 5. サマリ集計
  const byDealer = {}
  for (const code of TARGET_JCODES) byDealer[code] = { total: 0, willUpdate: 0, alreadyCorrect: 0, notInFirestore: 0 }
  for (const e of entries) {
    const d = byDealer[e.currentParent] || (byDealer[e.currentParent] = { total: 0, willUpdate: 0, alreadyCorrect: 0, notInFirestore: 0 })
    d.total += 1
    if (e.willUpdate) d.willUpdate += 1
    else if (!e.firestoreDocId) d.notInFirestore += 1
    else d.alreadyCorrect += 1
  }
  const willUpdateTotal = entries.filter((e) => e.willUpdate).length

  console.log('=== 集計結果 ===')
  console.log(`期間内 Bカート受注: ${inRange.length} 件`)
  console.log(`対象Jコード配下   : ${entries.length} 件`)
  console.log(`Firestore 更新対象: ${willUpdateTotal} 件`)
  console.log(`未解決            : ${unresolved.length} 件`)
  console.log('')
  console.log('代理店別:')
  for (const [code, s] of Object.entries(byDealer).sort()) {
    console.log(
      `  ${code}: total ${s.total} 件 / 更新対象 ${s.willUpdate} 件 / 既に正しい ${s.alreadyCorrect} 件 / Firestore未取込 ${s.notInFirestore} 件`,
    )
  }
  console.log('')

  // 6. JSON 保存（レビュー用）
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = `${LOGS_DIR}/rescue-v-to-j-${ts}.json`
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        dryRun: DRY_RUN,
        operator: OPERATOR,
        targetPeriod: { from: FROM_DATE, to: TO_DATE },
        targetJCodes: [...TARGET_JCODES],
        summary: {
          ordersInRange: inRange.length,
          candidates: entries.length,
          willUpdate: willUpdateTotal,
          unresolved: unresolved.length,
          byDealer,
        },
        entries,
        unresolved,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`📁 詳細ログ: ${logFile}`)
  console.log('')

  // 7. Firestore 書き込み（production 時のみ）
  if (DRY_RUN) {
    console.log('🟡 DRY RUN のため書き込みはしていません。')
    console.log('   本番実行: DRY_RUN=false OPERATOR="名前" node scripts/rescue-v-to-j-dealers.mjs')
    return
  }

  const toUpdate = entries.filter((e) => e.willUpdate && e.firestoreDocId)
  console.log(`▶ Firestore 書き込み開始: ${toUpdate.length} 件`)
  const writeErrors = []
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const chunk = toUpdate.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const e of chunk) {
      batch.update(db.collection('orders').doc(e.firestoreDocId), {
        dealerCode: e.currentParent,
      })
    }
    try {
      await batch.commit()
      console.log(`  ${i + chunk.length}/${toUpdate.length}`)
    } catch (err) {
      chunk.forEach((e) => writeErrors.push({ firestoreDocId: e.firestoreDocId, reason: err.message }))
      console.error(`  ❌ バッチ失敗 (${chunk.length} 件): ${err.message}`)
    }
  }

  // 監査ログ
  try {
    const logRef = await db.collection('ordersBackfillLogs').add({
      type: 'v-to-j-rescue',
      mode: 'production',
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      targetPeriod: { from: FROM_DATE, to: TO_DATE },
      targetJCodes: [...TARGET_JCODES],
      summary: {
        ordersInRange: inRange.length,
        candidates: entries.length,
        updated: toUpdate.length - writeErrors.length,
        failed: writeErrors.length,
        unresolved: unresolved.length,
      },
      byDealer,
      updatedOrderIds: toUpdate.map((e) => ({
        firestoreDocId: e.firestoreDocId,
        bcartOrderId: e.orderId,
        bcartOrderNo: e.orderNo,
        previousDealerCode: e.firestoreCurrentDealerCode,
        newDealerCode: e.currentParent,
      })),
      writeErrors,
      scriptVersion: '2026-04-21.v1',
    })
    console.log(`📝 監査ログ保存: ordersBackfillLogs/${logRef.id}`)
  } catch (err) {
    console.error('⚠️  監査ログ書き込み失敗:', err.message)
  }

  console.log('')
  console.log(`🟢 本番実行完了: Firestore orders ${toUpdate.length - writeErrors.length} 件を更新`)
  if (writeErrors.length > 0) {
    console.log(`⚠️  ${writeErrors.length} 件で書き込み失敗。詳細は監査ログ参照。`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
