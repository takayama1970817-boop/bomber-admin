/**
 * orders.dealerCode 欠落補完スクリプト（Admin SDK 版）
 *
 * 目的:
 *   本プロジェクト外の書き込み経路等で dealerCode フィールドが欠落している
 *   orders に対して、bcartCode / bcartOrderId を Bカート API に突合し、
 *   customer_parent_id を dealerCode として補完する。
 *
 * 絶対ルール（社長確認済・2026-04-24）:
 *   - total は絶対に触らない（本スクリプトは dealerCode 関連のみ追加）
 *   - customer_parent_id が Bカート側に存在する doc だけを補完候補とする
 *   - EXPECTED_PROJECT_ID 不一致なら即時終了
 *   - 既定 DRY_RUN（DRY_RUN=false 明示時のみ書き込み）
 *
 * 追加フィールド:
 *   - dealerCode: 'J0002' 等（空白・前後ホワイトスペースは trim）
 *   - dealerCodeBackfilledAt: serverTimestamp
 *   - dealerCodeBackfilledBy: OPERATOR
 *   （他のフィールドは一切触らない）
 *
 * 使用方法:
 *   # DRY_RUN（書き込みなし）: J0002 / 2026-04 だけ検証
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     YEAR_FROM=2026-04 YEAR_TO=2026-05 DEALER_FILTER=J0002 \
 *     node scripts/backfill-order-dealercode.mjs
 *
 *   # DRY_RUN 全代理店・全期間
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     node scripts/backfill-order-dealercode.mjs
 *
 *   # 本番実行（DRY_RUN 結果確認後のみ）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     DRY_RUN=false OPERATOR="社長 ボンバー" \
 *     node scripts/backfill-order-dealercode.mjs
 *
 * env:
 *   EXPECTED_PROJECT_ID   必須。service-account.json の project_id と一致必須
 *   SERVICE_ACCOUNT_FILE  既定: scripts/service-account.json
 *   DRY_RUN               'false' 以外は DRY。既定 DRY
 *   OPERATOR              本番実行時の操作者名（audit log）
 *   YEAR_FROM             YYYY-MM 形式。対象 orderDate の下限（含む）
 *   YEAR_TO               YYYY-MM 形式。対象 orderDate の上限（未満）
 *   DEALER_FILTER         特定 dealerCode に絞る（J0002 等）
 *
 * 出力:
 *   標準出力: 対象件数 / 補完予定件数 / 売上影響 / マッチなし件数 / サンプル
 *   Firestore: orderBackfillLogs/{auto-id} に実行記録
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken } from './_env.mjs'
import { buildDealerCodeMap, resolveDealerCode } from '../src/lib/dealerCodeMapping.js'

// === 必須 env ガード（SDK 初期化前）===
const EXPECTED_PROJECT_ID = process.env.EXPECTED_PROJECT_ID
if (!EXPECTED_PROJECT_ID) {
  console.error('❌ EXPECTED_PROJECT_ID は必須です（誤実行防止）。')
  console.error('   例: EXPECTED_PROJECT_ID=bomber-admin-test （テスト）')
  console.error('       EXPECTED_PROJECT_ID=bomber-admin      （本番）')
  process.exit(1)
}

const SA_FILE = process.env.SERVICE_ACCOUNT_FILE || 'scripts/service-account.json'
const SA_PATH = isAbsolute(SA_FILE) ? SA_FILE : resolve(process.cwd(), SA_FILE)
if (!existsSync(SA_PATH)) {
  console.error(`❌ service account JSON が見つかりません: ${SA_PATH}`)
  process.exit(1)
}
const serviceAccount = JSON.parse(readFileSync(SA_PATH, 'utf8'))
if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  console.error('❌ project_id 不一致のため停止します（誤実行防止）。')
  console.error(`   EXPECTED_PROJECT_ID : ${EXPECTED_PROJECT_ID}`)
  console.error(`   service account     : ${serviceAccount.project_id}`)
  console.error(`   service account file: ${SA_PATH}`)
  process.exit(1)
}

// === オプション env ===
const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const YEAR_FROM = process.env.YEAR_FROM || null // YYYY-MM
const YEAR_TO = process.env.YEAR_TO || null     // YYYY-MM (exclusive)
const DEALER_FILTER = process.env.DEALER_FILTER || null
const LOG_COLLECTION = 'orderBackfillLogs'
const BATCH_SIZE = 400
const SCRIPT_VERSION = '2026-04-24.v2-mapping'

function parseYm(s) {
  if (!s) return null
  if (!/^\d{4}-\d{2}$/.test(s)) {
    console.error(`❌ YEAR_FROM/TO は YYYY-MM 形式: ${s}`)
    process.exit(1)
  }
  const [y, m] = s.split('-').map(Number)
  // JST 00:00 ≒ UTC-9:00 で評価（bcart-sync と同仕様）
  return new Date(Date.UTC(y, m - 1, 1, -9, 0, 0))
}
const FROM_DATE = parseYm(YEAR_FROM) // null 可
const TO_DATE = parseYm(YEAR_TO)     // null 可

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()
const BCART_TOKEN = getBcartToken()
const PAGE_SIZE = 20

console.log('========================================')
console.log('  backfill-order-dealercode.mjs')
console.log(`  project_id         : ${serviceAccount.project_id}`)
console.log(`  client_email       : ${serviceAccount.client_email}`)
console.log(`  SA file            : ${SA_PATH}`)
console.log(`  mode               : ${DRY_RUN ? 'DRY_RUN（書き込まず集計のみ）' : '本番'}`)
console.log(`  operator           : ${OPERATOR}`)
console.log(`  YEAR_FROM          : ${YEAR_FROM || '(指定なし=全期間)'}`)
console.log(`  YEAR_TO            : ${YEAR_TO || '(指定なし=全期間)'}`)
console.log(`  DEALER_FILTER      : ${DEALER_FILTER || '(指定なし=全代理店)'}`)
console.log(`  script version     : ${SCRIPT_VERSION}`)
console.log('========================================\n')

// === Bカート API fetch（bcart-sync.mjs と同パターンのリトライ込み）===
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
    if (!res.ok) throw new Error(`Bカート API error: ${res.status}`)
    return res.json()
  }
  throw new Error('Bカート レート制限が継続。時間をおいて再実行してください。')
}

// === Bカート: 指定範囲の code → customer_parent_id マップを構築 ===
// orders は ordered_at 昇順。findStartOffsetByDate で開始位置を二分探索。
async function findStartOffsetByDate(targetDateStr) {
  const meta = await bcartFetch('orders', { limit: 1, offset: 0 })
  const total = meta.meta?.total || 0
  if (total === 0) return { startOffset: 0, total: 0 }
  let lo = 0, hi = total
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const aligned = Math.floor(mid / PAGE_SIZE) * PAGE_SIZE
    const data = await bcartFetch('orders', { limit: PAGE_SIZE, offset: aligned })
    const orders = data.orders
    if (!orders || orders.length === 0) { hi = aligned; continue }
    if (orders[0].ordered_at < targetDateStr) {
      lo = aligned + PAGE_SIZE
    } else {
      hi = aligned
    }
  }
  return { startOffset: lo, total }
}

async function buildBcartParentIdMap() {
  console.log('1. Bカート API から code → customer_parent_id マップを構築中...')
  // 範囲指定
  const fromStr = YEAR_FROM ? `${YEAR_FROM}-01` : null
  const toStr = YEAR_TO ? `${YEAR_TO}-01` : null

  let startOffset = 0
  if (fromStr) {
    console.log(`   開始位置を二分探索中 (>= ${fromStr})...`)
    const r = await findStartOffsetByDate(fromStr)
    // 二分探索は「orders[0].ordered_at >= fromStr の最初のページ」を返すが、
    // 1 ページ内に日付境界がまたがるケース（境界手前ページの後ろ半分が
    // fromStr 以降）で取りこぼしが発生する。
    // そのため 1 ページ手前から走査開始し、ループ内で fromStr フィルタを適用する。
    startOffset = Math.max(0, r.startOffset - PAGE_SIZE)
    console.log(`   二分探索結果 offset: ${r.startOffset} → 1ページ戻して開始 offset: ${startOffset} / 全${r.total}件`)
  }

  const map = new Map()
  let offset = startOffset
  let fetched = 0
  let boundaryReached = false
  const MAX_PAGES = 2000 // safety cap (最大 40,000件)
  let pageCount = 0

  while (true) {
    const data = await bcartFetch('orders', { limit: PAGE_SIZE, offset })
    const items = data.orders
    if (!items || items.length === 0) break
    for (const o of items) {
      // 範囲外チェック（下限）: 境界手前ページに含まれる fromStr 以前の order は skip
      if (fromStr && o.ordered_at < fromStr) continue
      // 範囲外チェック（上限）
      if (toStr && o.ordered_at >= toStr) {
        boundaryReached = true
        break
      }
      // code は必ず存在するはず
      const code = o.code
      if (!code) continue
      const parent = String(o.customer_parent_id ?? o.parent_id ?? o.parent_member_id ?? '').trim()
      map.set(String(code), {
        parentId: parent,
        bcartOrderId: o.id,
        orderedAt: o.ordered_at,
        customerName: o.customer_comp_name || '',
      })
      fetched++
    }
    pageCount++
    if (offset % 200 === 0 || items.length < PAGE_SIZE || boundaryReached) {
      console.log(`   offset=${offset}: 収集${fetched}件`)
    }
    if (boundaryReached || items.length < PAGE_SIZE) break
    if (pageCount >= MAX_PAGES) {
      console.warn(`   ⚠️ MAX_PAGES=${MAX_PAGES} に到達。打ち切り`)
      break
    }
    offset += PAGE_SIZE
    // Bカート API レート制限対策: ページ毎に小休止
    // （全期間で使う場合は 5400 ページあたりから 429 が出始めるため）
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`   Bカート code マップ: ${map.size} 件\n`)
  return map
}

// === Firestore: dealerCode 欠落 orders を収集 ===
// 安全ガード: 同一 bcartCode で valid doc が 2 件以上ある場合は自動処理しない。
//   （PR #58 cleanup 後に残った「両方 dealerCode 空」162 ペア = 324 doc が該当。
//     両方に dealerCode を書くと再び重複ペア問題を作ってしまうため）
async function collectCandidates() {
  console.log('2. Firestore から dealerCode 欠落 orders を収集中...')
  const snap = await db.collection('orders').get()

  // Pass A: bcartCode → valid doc 数をカウント（重複検知）
  const bcartCodeCount = new Map()
  for (const d of snap.docs) {
    const o = d.data()
    if (o.isDeprecated === true) continue
    const code = o.bcartCode || o.bcartOrderNumber || null
    if (!code) continue
    bcartCodeCount.set(code, (bcartCodeCount.get(code) || 0) + 1)
  }

  // Pass B: dealerCode 空 doc を候補に集める（重複ペア所属は skip）
  const candidates = []
  let totalValid = 0
  let alreadyFilled = 0
  let outOfRange = 0
  let depCount = 0
  let skippedInDupPair = 0

  for (const d of snap.docs) {
    const o = d.data()
    if (o.isDeprecated === true) { depCount++; continue }
    totalValid++
    const dt = o.orderDate?.toDate?.()
    if (!dt) continue
    if (FROM_DATE && dt < FROM_DATE) { outOfRange++; continue }
    if (TO_DATE && dt >= TO_DATE) { outOfRange++; continue }
    const code = String(o.dealerCode || '').trim()
    if (code) { alreadyFilled++; continue }
    // 重複ペアの一員なら自動処理しない
    const bcode = o.bcartCode || o.bcartOrderNumber || null
    if (bcode && (bcartCodeCount.get(bcode) || 0) >= 2) {
      skippedInDupPair++
      continue
    }
    candidates.push({
      docId: d.id,
      ref: d.ref,
      bcartCode: bcode,
      orderDate: dt,
      total: Number(o.total) || 0,
      companyName: o.companyName || '',
    })
  }

  console.log(`   valid orders           : ${totalValid} (deprecated除外 ${depCount})`)
  console.log(`   期間内かつ dealerCode 空: ${candidates.length}`)
  console.log(`   期間内かつ dealerCode あり (=スキップ): ${alreadyFilled}`)
  console.log(`   期間外 (=スキップ)      : ${outOfRange}`)
  console.log(`   重複ペア所属で自動処理対象外: ${skippedInDupPair} (PR #58 cleanup 後の162ペア等)\n`)
  return { candidates, skippedInDupPair }
}

// === マッチング + 補完対象確定 ===
//
// マッピング層（src/lib/dealerCodeMapping.js）を経由して
// Bカート customer_parent_id → アプリ dealerCode に変換する。
//
// - v1〜v6 のような Bカート 独自 ID → 登録があれば J0016〜J0021 等に変換
// - 未登録の v 系 → resolveDealerCode が '' を返す（fail-closed・スキップ）
// - J0002 等の同一 ID → そのまま使う
function resolveTargets(candidates, bcartMap, dealerCodeMap) {
  console.log('3. Bカート突合で dealerCode 決定中...')
  const targets = []
  const unresolved = [] // Bカート側 code なし
  const noParent = []   // code あるが customer_parent_id 空
  const unmapped = []   // v 系で fail-closed（未マッピング）
  const filteredOut = [] // DEALER_FILTER 指定で除外

  for (const c of candidates) {
    if (!c.bcartCode) {
      unresolved.push({ ...c, reason: 'bcartCode 欠落' })
      continue
    }
    const b = bcartMap.get(String(c.bcartCode))
    if (!b) {
      unresolved.push({ ...c, reason: 'Bカート side 未収集（範囲外 or 該当なし）' })
      continue
    }
    const rawParent = b.parentId
    if (!rawParent) {
      noParent.push({ ...c, reason: 'customer_parent_id 空' })
      continue
    }
    // マッピング適用（v1 → J0016 等。未マッピング v 系は '' を返す = fail-closed）
    const resolvedCode = resolveDealerCode(rawParent, dealerCodeMap)
    if (!resolvedCode) {
      unmapped.push({ ...c, rawParent, reason: '未マッピング v 系（fail-closed）' })
      continue
    }
    if (DEALER_FILTER && resolvedCode !== DEALER_FILTER) {
      filteredOut.push({ ...c, resolvedCode, rawParent })
      continue
    }
    targets.push({ ...c, resolvedCode, rawParent })
  }
  console.log(`   補完候補             : ${targets.length}`)
  console.log(`   Bカートに存在せず    : ${unresolved.length}`)
  console.log(`   親ID空（マッチ不可）: ${noParent.length}`)
  console.log(`   未マッピング v 系    : ${unmapped.length} (fail-closed・スキップ)`)
  if (DEALER_FILTER) console.log(`   DEALER_FILTER で除外: ${filteredOut.length}`)
  console.log('')
  return { targets, unresolved, noParent, unmapped, filteredOut }
}

// === DRY_RUN サマリ + 本番書き込み ===
async function applyOrSummarize(targets) {
  // dealerCode 別集計
  const byDealer = new Map()
  let impactTotal = 0
  for (const t of targets) {
    const code = t.resolvedCode
    if (!byDealer.has(code)) byDealer.set(code, { count: 0, total: 0 })
    const e = byDealer.get(code)
    e.count += 1
    e.total += t.total
    impactTotal += t.total
  }
  console.log('4. 補完予定 サマリ')
  console.log(`   対象件数            : ${targets.length}`)
  console.log(`   売上影響（total合算）: ¥${impactTotal.toLocaleString()}`)
  console.log(`   代理店別内訳:`)
  const sorted = [...byDealer.entries()].sort((a, b) => b[1].total - a[1].total)
  for (const [code, e] of sorted) {
    console.log(`     ${code}: ${e.count} 件 / ¥${e.total.toLocaleString()}`)
  }

  if (targets.length === 0) return { updated: 0, failed: [], impactTotal, byDealer: sorted }
  console.log('\n   サンプル（最初の5件）:')
  for (const t of targets.slice(0, 5)) {
    const dt = t.orderDate.toISOString().slice(0, 10)
    console.log(`     [${DRY_RUN ? 'DRY' : '更新'}] ${t.docId} | ${dt} | ${t.companyName} | → dealerCode=${t.resolvedCode} | total=¥${t.total.toLocaleString()}`)
  }

  if (DRY_RUN) {
    console.log('\n🧪 DRY_RUN のため Firestore 書き込みはスキップします。')
    return { updated: 0, failed: [], impactTotal, byDealer: sorted }
  }

  // 本番書き込み
  console.log(`\n⏳ 本番更新を開始（${BATCH_SIZE}件ずつバッチ）...`)
  const nowTs = FieldValue.serverTimestamp()
  let updated = 0
  const failed = []
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const t of chunk) {
      // total / subtotal / tax / shipping 等は絶対に触らない。
      // dealerCode 関連 3フィールドのみ additive に書く。
      batch.update(t.ref, {
        dealerCode: t.resolvedCode,
        dealerCodeBackfilledAt: nowTs,
        dealerCodeBackfilledBy: OPERATOR,
      })
    }
    try {
      await batch.commit()
      updated += chunk.length
      console.log(`  ✓ ${updated} / ${targets.length} 件 完了`)
    } catch (e) {
      console.error(`  ❌ batch 失敗 (offset=${i}):`, e.message)
      failed.push(...chunk.map((t) => ({ id: t.docId, error: e.message })))
    }
  }
  return { updated, failed, impactTotal, byDealer: sorted }
}

async function writeAuditLog({ mode, candidateCount, targetCount, updated, failed, impactTotal, byDealer, unresolvedCount, noParentCount, filteredOutCount, skippedInDupPair = 0, unmappedCount = 0 }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'order-dealercode-backfill',
      mode,
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      expectedProjectId: EXPECTED_PROJECT_ID,
      yearFrom: YEAR_FROM,
      yearTo: YEAR_TO,
      dealerFilter: DEALER_FILTER,
      candidateCount,
      targetCount,
      updatedCount: updated,
      failedCount: failed.length,
      failedIds: failed.map((f) => f.id).slice(0, 200),
      unresolvedCount,
      noParentCount,
      skippedInDupPair,
      filteredOutCount,
      unmappedCount,
      impactTotal,
      byDealer: Object.fromEntries(byDealer.map(([code, e]) => [code, e])),
      scriptVersion: SCRIPT_VERSION,
    })
    console.log(`\n📝 監査ログ保存: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️ 監査ログ書き込み失敗（処理自体は完了）:', e.message)
    return null
  }
}

async function buildDealerCodeMapFromFirestore() {
  console.log('0. allowedEmails から dealerCode マッピング構築中...')
  const snap = await db.collection('allowedEmails').where('role', '==', 'dealer').get()
  const records = snap.docs.map((d) => d.data())
  const map = buildDealerCodeMap(records)
  console.log(`   登録 dealer: ${records.length} 件 / マッピング登録: ${map.byBcartParent.size} 件`)
  if (map.byBcartParent.size > 0) {
    console.log(`   登録済みマッピング:`)
    for (const [bp, dc] of map.byBcartParent.entries()) {
      console.log(`     ${bp} → ${dc}`)
    }
  }
  console.log('')
  return map
}

async function main() {
  const dealerCodeMap = await buildDealerCodeMapFromFirestore()
  const bcartMap = await buildBcartParentIdMap()
  const { candidates, skippedInDupPair } = await collectCandidates()
  if (candidates.length === 0) {
    console.log('✅ 補完対象なし。終了します。')
    await writeAuditLog({
      mode: DRY_RUN ? 'dry-run' : 'production',
      candidateCount: 0, targetCount: 0, updated: 0, failed: [],
      impactTotal: 0, byDealer: [], unresolvedCount: 0, noParentCount: 0, filteredOutCount: 0,
      skippedInDupPair, unmappedCount: 0,
    })
    process.exit(0)
  }
  const { targets, unresolved, noParent, unmapped, filteredOut } = resolveTargets(candidates, bcartMap, dealerCodeMap)
  const result = await applyOrSummarize(targets)

  console.log('\n========================================')
  console.log(`  ${DRY_RUN ? '【DRY_RUN】想定結果' : '補完完了'}`)
  console.log('========================================')
  console.log(`  Firestore 候補       : ${candidates.length}`)
  console.log(`  補完対象（確定）     : ${targets.length}`)
  console.log(`  Bカート側マッチなし  : ${unresolved.length}`)
  console.log(`  親ID空でスキップ     : ${noParent.length}`)
  console.log(`  未マッピング v 系    : ${unmapped.length} (fail-closed)`)
  console.log(`  重複ペアで除外       : ${skippedInDupPair}`)
  if (DEALER_FILTER) console.log(`  DEALER_FILTER 除外   : ${filteredOut.length}`)
  console.log(`  売上影響             : ¥${result.impactTotal.toLocaleString()}`)
  if (!DRY_RUN) {
    console.log(`  更新件数             : ${result.updated}`)
    console.log(`  失敗件数             : ${result.failed.length}`)
  }

  await writeAuditLog({
    mode: DRY_RUN ? 'dry-run' : 'production',
    candidateCount: candidates.length,
    targetCount: targets.length,
    updated: result.updated,
    failed: result.failed,
    impactTotal: result.impactTotal,
    byDealer: result.byDealer,
    unresolvedCount: unresolved.length,
    noParentCount: noParent.length,
    skippedInDupPair,
    filteredOutCount: filteredOut.length,
    unmappedCount: unmapped.length,
  })

  process.exit(result.failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
