/**
 * dealerSalons コレクション再構築スクリプト
 *
 * 背景:
 *   代理店↔サロン紐付け `dealerSalons` が空だったため、
 *   /dealer の集計（aggregate-dealer-monthly.mjs）で J0016〜J0022 が
 *   サロン 0 件の「代理店なし」扱いになっていた。
 *   Bカート会員マスタの parent_id は正しく更新済みなので、これを元に再構築する。
 *
 * 仕様:
 *   - Bカート 会員一覧 API から customer を全件取得
 *   - parent_id が「allowedEmails に role=dealer で登録された dealerCode」に
 *     一致するものを対象とする（未登録 parent_id や V 等は無視）
 *   - 各サロンを `dealerSalons/{auto-id}` に { dealerCode, companyName, type, ... } として作成
 *   - `type` は既定 'sub'。ただし companyName が代理店自身の companyName と
 *     一致する場合は 'own' を自動付与（後から /admin/kickback で手動修正も可）
 *   - 既存 dealerSalons があるペアはスキップ（REPLACE=true で削除→再作成）
 *
 * 環境変数:
 *   DRY_RUN             既定 true。本番書き込みは DRY_RUN=false
 *   OPERATOR            監査ログ記録用（本番時推奨）
 *   TARGET_JCODES       対象 dealerCode カンマ区切り（既定: 全代理店）
 *                        例: TARGET_JCODES=J0016,J0017,J0018,J0019,J0020,J0021,J0022
 *   DEFAULT_TYPE        既定 'sub'。既存 dealerSalons の構造に合わせる
 *   REPLACE             既定 false。true なら対象 dealerCode の既存 dealerSalons を
 *                        全削除してから再作成
 *   SERVICE_ACCOUNT_PATH / EXPECTED_PROJECT_ID は _env.mjs の仕様に従う
 *
 * 出力:
 *   - 標準出力: サマリ + 代理店別内訳
 *   - scripts/logs/rebuild-dealer-salons-<timestamp>.json  詳細
 *   - 本番時: dealerSalonsRebuildLogs/{auto-id} に監査ログ
 *
 * 使用例:
 *   # dry-run 全件
 *   node scripts/rebuild-dealer-salons.mjs
 *
 *   # J0016〜J0022 のみ dry-run
 *   $env:TARGET_JCODES="J0016,J0017,J0018,J0019,J0020,J0021,J0022"
 *   node scripts/rebuild-dealer-salons.mjs
 *
 *   # 本番
 *   $env:DRY_RUN="false"
 *   $env:OPERATOR="社長 ボンバー"
 *   node scripts/rebuild-dealer-salons.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken, loadAdminCredential } from './_env.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const { serviceAccount, projectId, credentialPath } = loadAdminCredential(SCRIPTS_DIR)
initializeApp({ credential: cert(serviceAccount), projectId })
const db = getFirestore()

const BCART_TOKEN = getBcartToken()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || 'sub'
const REPLACE = process.env.REPLACE === 'true'

const TARGET_JCODES = new Set(
  (process.env.TARGET_JCODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

const BCART_PAGE = 100
const BATCH_SIZE = 400
const LOGS_DIR = `${SCRIPTS_DIR}/logs`

// ========================================
// Bcart API
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
  throw new Error('Bカート レート制限継続中')
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

function parentIdOf(rec) {
  return String(rec?.parent_id ?? rec?.customer_parent_id ?? rec?.parent_member_id ?? '').trim()
}

function companyNameOf(rec) {
  return (rec?.comp_name || rec?.customer_comp_name || rec?.name || rec?.customer_name || '').trim()
}

// ========================================
// main
// ========================================
async function main() {
  console.log('=== dealerSalons 再構築 ===')
  console.log(`モード   : ${DRY_RUN ? '🟡 DRY RUN' : '🔴 本番実行'}`)
  console.log(`OPERATOR : ${OPERATOR}`)
  console.log(`credential path  : ${credentialPath}`)
  console.log(`projectId        : ${projectId}`)
  console.log(`対象Jコード       : ${TARGET_JCODES.size ? [...TARGET_JCODES].join(', ') : '(未指定 = 登録済み全代理店)'}`)
  console.log(`DEFAULT_TYPE     : ${DEFAULT_TYPE}`)
  console.log(`REPLACE          : ${REPLACE}`)
  console.log('')

  // 1. Fetch registered dealers (allowedEmails)
  console.log('▶ allowedEmails 取得中...')
  const dealersSnap = await db.collection('allowedEmails').where('role', '==', 'dealer').get()
  const dealerCodes = new Set()
  const dealerOwnCompanyName = new Map()
  dealersSnap.forEach((d) => {
    const data = d.data()
    const code = String(data.dealerCode || '').trim()
    if (!code) return
    dealerCodes.add(code)
    const name = (data.companyName || '').trim()
    if (name) dealerOwnCompanyName.set(code, name)
  })
  console.log(`  登録代理店: ${dealerCodes.size} 社`)
  if (TARGET_JCODES.size > 0) {
    const missing = [...TARGET_JCODES].filter((c) => !dealerCodes.has(c))
    if (missing.length > 0) {
      console.log(`  ⚠️  対象Jコードのうち allowedEmails に未登録: ${missing.join(', ')}`)
    }
  }
  console.log('')

  // 2. Fetch Bcart customers
  console.log('▶ Bカート 会員一覧取得中...')
  const customers = await fetchAllBcartCustomers()
  console.log(`  総会員数: ${customers.length} 件`)
  console.log('')

  // 3. Group by dealer (filter to registered dealers, apply TARGET_JCODES if set)
  const byDealer = new Map()
  let unmappedCount = 0
  for (const c of customers) {
    const parent = parentIdOf(c)
    if (!parent) continue
    if (!dealerCodes.has(parent)) {
      unmappedCount += 1
      continue
    }
    if (TARGET_JCODES.size > 0 && !TARGET_JCODES.has(parent)) continue
    if (!byDealer.has(parent)) byDealer.set(parent, [])
    byDealer.get(parent).push(c)
  }
  console.log(`▶ 対象 customer 集約`)
  console.log(`  対象代理店: ${byDealer.size} 社`)
  console.log(`  allowedEmails に未登録の parent_id を持つ会員: ${unmappedCount} 件（無視）`)
  console.log('')

  // 4. Load existing dealerSalons to avoid duplicates
  console.log('▶ 既存 dealerSalons 取得中...')
  const existingSnap = await db.collection('dealerSalons').get()
  const existingByDealer = new Map() // dealerCode -> Map<companyName, docId>
  existingSnap.forEach((d) => {
    const data = d.data()
    const code = String(data.dealerCode || '').trim()
    const name = (data.companyName || '').trim()
    if (!code || !name) return
    if (!existingByDealer.has(code)) existingByDealer.set(code, new Map())
    existingByDealer.get(code).set(name, d.id)
  })
  console.log(`  既存 dealerSalons 総件数: ${existingSnap.size} 件`)
  console.log('')

  // 5. Plan creates/deletes
  const toCreate = []
  const toDelete = []
  const skipped = []

  for (const [dealerCode, custs] of byDealer) {
    const existing = existingByDealer.get(dealerCode) || new Map()
    if (REPLACE) {
      for (const [name, docId] of existing) {
        toDelete.push({ docId, dealerCode, companyName: name })
      }
    }
    const addedNames = new Set()
    const ownName = dealerOwnCompanyName.get(dealerCode) || ''
    for (const c of custs) {
      const name = companyNameOf(c)
      if (!name) continue
      if (addedNames.has(name)) continue
      if (!REPLACE && existing.has(name)) {
        skipped.push({ dealerCode, companyName: name, reason: 'already exists' })
        continue
      }
      const type = ownName && ownName === name ? 'own' : DEFAULT_TYPE
      toCreate.push({
        dealerCode,
        companyName: name,
        type,
        sourceCustomerId: String(c.id || ''),
      })
      addedNames.add(name)
    }
  }

  // 6. Per-dealer summary
  const perDealer = {}
  for (const code of dealerCodes) {
    if (TARGET_JCODES.size > 0 && !TARGET_JCODES.has(code)) continue
    perDealer[code] = {
      create: 0,
      skip: 0,
      delete: 0,
      existing: (existingByDealer.get(code) || new Map()).size,
      bcartMembers: (byDealer.get(code) || []).length,
    }
  }
  for (const c of toCreate) {
    perDealer[c.dealerCode] = perDealer[c.dealerCode] || { create: 0, skip: 0, delete: 0, existing: 0, bcartMembers: 0 }
    perDealer[c.dealerCode].create += 1
  }
  for (const s of skipped) {
    perDealer[s.dealerCode] = perDealer[s.dealerCode] || { create: 0, skip: 0, delete: 0, existing: 0, bcartMembers: 0 }
    perDealer[s.dealerCode].skip += 1
  }
  for (const d of toDelete) {
    perDealer[d.dealerCode] = perDealer[d.dealerCode] || { create: 0, skip: 0, delete: 0, existing: 0, bcartMembers: 0 }
    perDealer[d.dealerCode].delete += 1
  }

  console.log('=== 計画 ===')
  console.log(`作成予定: ${toCreate.length} 件`)
  if (REPLACE) console.log(`削除予定: ${toDelete.length} 件`)
  console.log(`既存 skip: ${skipped.length} 件`)
  console.log('')
  console.log('代理店別:')
  const sorted = Object.keys(perDealer).sort()
  for (const code of sorted) {
    const s = perDealer[code]
    const ownName = dealerOwnCompanyName.get(code) || ''
    console.log(
      `  ${code.padEnd(6)} ${ownName.padEnd(24)} Bcart会員 ${s.bcartMembers} / 既存 ${s.existing} / 作成 ${s.create} / skip ${s.skip}${REPLACE ? ` / 削除 ${s.delete}` : ''}`,
    )
  }
  console.log('')

  // 7. Save JSON log
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = `${LOGS_DIR}/rebuild-dealer-salons-${ts}.json`
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        dryRun: DRY_RUN,
        operator: OPERATOR,
        projectId,
        targetJCodes: [...TARGET_JCODES],
        defaultType: DEFAULT_TYPE,
        replace: REPLACE,
        summary: {
          registeredDealers: dealerCodes.size,
          bcartCustomers: customers.length,
          targetDealers: byDealer.size,
          unmappedMembers: unmappedCount,
          create: toCreate.length,
          delete: toDelete.length,
          skip: skipped.length,
        },
        perDealer,
        toCreate,
        toDelete,
        skipped,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`📁 詳細ログ: ${logFile}`)
  console.log('')

  if (DRY_RUN) {
    console.log('🟡 DRY RUN のため書き込みはしていません。')
    console.log('   本番実行: DRY_RUN=false OPERATOR="名前" node scripts/rebuild-dealer-salons.mjs')
    return
  }

  // 8. Delete first (if REPLACE)
  if (REPLACE && toDelete.length > 0) {
    console.log(`▶ 既存 dealerSalons 削除: ${toDelete.length} 件`)
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const chunk = toDelete.slice(i, i + BATCH_SIZE)
      const batch = db.batch()
      for (const t of chunk) batch.delete(db.collection('dealerSalons').doc(t.docId))
      await batch.commit()
      console.log(`  削除 ${i + chunk.length}/${toDelete.length}`)
    }
    console.log('')
  }

  // 9. Create
  console.log(`▶ dealerSalons 作成: ${toCreate.length} 件`)
  const writeErrors = []
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const chunk = toCreate.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const c of chunk) {
      const ref = db.collection('dealerSalons').doc()
      batch.set(ref, {
        dealerCode: c.dealerCode,
        companyName: c.companyName,
        type: c.type,
        sourceCustomerId: c.sourceCustomerId,
        createdAt: FieldValue.serverTimestamp(),
        rebuiltAt: FieldValue.serverTimestamp(),
        rebuiltBy: OPERATOR,
      })
    }
    try {
      await batch.commit()
      console.log(`  作成 ${i + chunk.length}/${toCreate.length}`)
    } catch (e) {
      chunk.forEach((c) => writeErrors.push({ dealerCode: c.dealerCode, companyName: c.companyName, reason: e.message }))
      console.error(`  ❌ バッチ失敗 (${chunk.length} 件): ${e.message}`)
    }
  }

  // 10. Audit log
  try {
    const logRef = await db.collection('dealerSalonsRebuildLogs').add({
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      projectId,
      targetJCodes: [...TARGET_JCODES],
      replace: REPLACE,
      created: toCreate.length - writeErrors.length,
      deleted: toDelete.length,
      skipped: skipped.length,
      failed: writeErrors.length,
      perDealer,
      writeErrors,
      scriptVersion: '2026-04-21.v1',
    })
    console.log(`📝 監査ログ: dealerSalonsRebuildLogs/${logRef.id}`)
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗:', e.message)
  }

  console.log('')
  console.log(`🟢 本番実行完了: dealerSalons ${toCreate.length - writeErrors.length} 件作成`)
  if (writeErrors.length > 0) {
    console.log(`⚠️  ${writeErrors.length} 件で書き込み失敗`)
  }
  console.log('')
  console.log('次の手順: 対象代理店の snapshot を再集計してください')
  console.log('  $env:DRY_RUN="false"; $env:OPERATOR="社長 ボンバー"')
  if (TARGET_JCODES.size > 0) {
    console.log(`  foreach ($c in @('${[...TARGET_JCODES].join("','")}')) { $env:DEALER_CODE=$c; node scripts/aggregate-dealer-monthly.mjs }`)
    console.log('  Remove-Item Env:DEALER_CODE')
  } else {
    console.log('  node scripts/aggregate-dealer-monthly.mjs')
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
