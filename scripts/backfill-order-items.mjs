/**
 * orders.items 欠落補完スクリプト（Admin SDK 版・Bカート order_products 経由）
 *
 * 目的:
 *   Firestore orders で items が空 / 欠落のドキュメントを、Bカート
 *   order_products API から再取得して items 配列を additive 補完する。
 *   PR #65 で UI に「商品明細未取得」表示を追加した、その根本対応。
 *
 * 絶対ルール:
 *   - 既定 DRY_RUN（DRY_RUN=false 明示時のみ書込）
 *   - items のみ書込（total / subtotal / dealerCode / companyName 等は無触）
 *   - 既に items.length > 0 の doc はスキップ（冪等）
 *   - bcartOrderId が欠落している doc はスキップ
 *   - Bカート で商品が取れなかったら何も書かない
 *
 * items の shape（bcart-sync.mjs と同一）:
 *   { name, sku, campaign, unit, price, qty }
 *
 * 使用方法:
 *   # DRY_RUN（書き込みなし）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     YEAR_FROM=2026-04 YEAR_TO=2026-05 DEALER_FILTER=J0015 \
 *     node scripts/backfill-order-items.mjs
 *
 *   # 本番（DRY_RUN 結果確認後）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     DRY_RUN=false OPERATOR="社長 ボンバー" \
 *     YEAR_FROM=2026-04 YEAR_TO=2026-05 \
 *     node scripts/backfill-order-items.mjs
 *
 * env:
 *   EXPECTED_PROJECT_ID   必須
 *   SERVICE_ACCOUNT_FILE  既定: scripts/service-account.json
 *   DRY_RUN               'false' 以外は DRY
 *   OPERATOR              本番実行時必須
 *   YEAR_FROM             YYYY-MM 形式（orderDate 下限）
 *   YEAR_TO               YYYY-MM 形式（orderDate 上限・未満）
 *   DEALER_FILTER         特定 dealerCode に絞る
 *
 * 出力:
 *   標準出力: 対象件数 / 補完件数 / Bカート未マッチ件数 / レート制限など
 *   Firestore: orderItemsBackfillLogs/{auto-id}
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken } from './_env.mjs'

const EXPECTED_PROJECT_ID = process.env.EXPECTED_PROJECT_ID
if (!EXPECTED_PROJECT_ID) {
  console.error('❌ EXPECTED_PROJECT_ID は必須です（誤実行防止）。')
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
  console.error('❌ project_id 不一致のため停止します。')
  console.error(`   EXPECTED_PROJECT_ID : ${EXPECTED_PROJECT_ID}`)
  console.error(`   service account     : ${serviceAccount.project_id}`)
  process.exit(1)
}

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const YEAR_FROM = process.env.YEAR_FROM || null
const YEAR_TO = process.env.YEAR_TO || null
const DEALER_FILTER = process.env.DEALER_FILTER || null
const LOG_COLLECTION = 'orderItemsBackfillLogs'
const BATCH_SIZE = 400
const SCRIPT_VERSION = '2026-04-24.v1'

if (!DRY_RUN && OPERATOR === 'unknown') {
  console.error('❌ 本番実行時は OPERATOR が必須です。')
  process.exit(1)
}

function parseYm(s) {
  if (!s) return null
  if (!/^\d{4}-\d{2}$/.test(s)) {
    console.error(`❌ YEAR_FROM/TO は YYYY-MM 形式: ${s}`)
    process.exit(1)
  }
  const [y, m] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1, -9, 0, 0))
}
const FROM_DATE = parseYm(YEAR_FROM)
const TO_DATE = parseYm(YEAR_TO)

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()
const BCART_TOKEN = getBcartToken()
const PAGE_SIZE = 20

console.log('========================================')
console.log('  backfill-order-items.mjs')
console.log(`  project_id     : ${serviceAccount.project_id}`)
console.log(`  client_email   : ${serviceAccount.client_email}`)
console.log(`  SA file        : ${SA_PATH}`)
console.log(`  mode           : ${DRY_RUN ? 'DRY_RUN（書き込みなし）' : '本番'}`)
console.log(`  operator       : ${OPERATOR}`)
console.log(`  YEAR_FROM      : ${YEAR_FROM || '(指定なし)'}`)
console.log(`  YEAR_TO        : ${YEAR_TO || '(指定なし)'}`)
console.log(`  DEALER_FILTER  : ${DEALER_FILTER || '(指定なし)'}`)
console.log(`  script version : ${SCRIPT_VERSION}`)
console.log('========================================\n')

// === Bカート API fetch（リトライ込み）===
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

// === Firestore: items 欠落 doc を収集 ===
async function collectCandidates() {
  console.log('1. Firestore から items 欠落 orders を収集中...')
  const snap = await db.collection('orders').get()
  const candidates = []
  let totalValid = 0, alreadyHasItems = 0, outOfRange = 0
  let depCount = 0, noBcartOrderId = 0, dealerFilterOut = 0

  for (const d of snap.docs) {
    const o = d.data()
    if (o.isDeprecated === true) { depCount++; continue }
    totalValid++
    const dt = o.orderDate?.toDate?.()
    if (!dt) continue
    if (FROM_DATE && dt < FROM_DATE) { outOfRange++; continue }
    if (TO_DATE && dt >= TO_DATE) { outOfRange++; continue }
    if (DEALER_FILTER && String(o.dealerCode || '').trim() !== DEALER_FILTER) {
      dealerFilterOut++
      continue
    }
    if (Array.isArray(o.items) && o.items.length > 0) {
      alreadyHasItems++
      continue
    }
    if (o.bcartOrderId == null) {
      noBcartOrderId++
      continue
    }
    candidates.push({
      docId: d.id,
      ref: d.ref,
      bcartOrderId: o.bcartOrderId,
      bcartCode: o.bcartCode || o.bcartOrderNumber,
      total: Number(o.total) || 0,
      orderDate: dt,
      companyName: o.companyName || '',
      dealerCode: String(o.dealerCode || '').trim(),
    })
  }
  console.log(`   valid orders                : ${totalValid} (deprecated除外 ${depCount})`)
  console.log(`   期間内 + items 補完候補     : ${candidates.length}`)
  console.log(`   既に items 取得済み(スキップ): ${alreadyHasItems}`)
  console.log(`   bcartOrderId 欠落(スキップ) : ${noBcartOrderId}`)
  console.log(`   期間外(スキップ)            : ${outOfRange}`)
  if (DEALER_FILTER) console.log(`   DEALER_FILTER 除外          : ${dealerFilterOut}`)
  console.log('')
  return { candidates, alreadyHasItems, noBcartOrderId, dealerFilterOut }
}

// === Bカート order_products を全件 walk して order_id → items[] マップを構築 ===
//
// order_products は単純 offset ベースで全件取得が必要。
// 大量取得するため、対象 bcartOrderId の Set で動的にフィルタする。
async function fetchOrderProductsFor(targetOrderIds) {
  console.log('2. Bカート order_products から対象商品を取得中...')
  console.log(`   対象 bcartOrderId 件数: ${targetOrderIds.size}`)
  const productMap = new Map() // bcartOrderId → items[]
  let totalFetched = 0, totalMatched = 0
  let opOffset = 0
  const MAX_PAGES = 5000 // safety cap

  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
    const data = await bcartFetch('order_products', { limit: PAGE_SIZE, offset: opOffset })
    const key = Object.keys(data).find((k) => Array.isArray(data[k])) || 'order_products'
    const items = data[key]
    if (!items || items.length === 0) break
    for (const p of items) {
      totalFetched++
      if (!targetOrderIds.has(p.order_id)) continue
      totalMatched++
      const item = {
        name: p.product_name || '',
        sku: p.jan_code || '',
        campaign: p.set_name || '',
        unit: p.set_unit || '',
        price: p.unit_price || 0,
        qty: p.order_pro_count || 1,
      }
      if (!productMap.has(p.order_id)) productMap.set(p.order_id, [])
      productMap.get(p.order_id).push(item)
    }
    if (opOffset % 1000 === 0 || items.length < PAGE_SIZE) {
      console.log(`   offset=${opOffset}: 走査${totalFetched}件 / マッチ${totalMatched}件 (${productMap.size} orders)`)
    }
    if (items.length < PAGE_SIZE) break
    opOffset += PAGE_SIZE
    // レート制限対策
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`   完了: 走査${totalFetched}件 / マッチ${totalMatched}件 / ${productMap.size}注文分の明細取得\n`)
  return productMap
}

async function writeAuditLog({ mode, candidateCount, updated, failed, noProductsCount, alreadyHasItems, noBcartOrderId }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'order-items-backfill',
      mode,
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      expectedProjectId: EXPECTED_PROJECT_ID,
      yearFrom: YEAR_FROM,
      yearTo: YEAR_TO,
      dealerFilter: DEALER_FILTER,
      candidateCount,
      updatedCount: updated,
      failedCount: failed.length,
      failedIds: failed.map((f) => f.id).slice(0, 200),
      noProductsCount,
      alreadyHasItems,
      noBcartOrderId,
      scriptVersion: SCRIPT_VERSION,
    })
    console.log(`\n📝 監査ログ保存: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗:', e.message)
    return null
  }
}

async function main() {
  const { candidates, alreadyHasItems, noBcartOrderId } = await collectCandidates()
  if (candidates.length === 0) {
    console.log('✅ 補完対象なし。終了します。')
    await writeAuditLog({
      mode: DRY_RUN ? 'dry-run' : 'production',
      candidateCount: 0, updated: 0, failed: [], noProductsCount: 0,
      alreadyHasItems, noBcartOrderId,
    })
    process.exit(0)
  }

  const targetOrderIds = new Set(candidates.map((c) => c.bcartOrderId))
  const productMap = await fetchOrderProductsFor(targetOrderIds)

  // マッチング結果
  const targets = []
  const noProducts = []
  for (const c of candidates) {
    const items = productMap.get(c.bcartOrderId)
    if (!items || items.length === 0) {
      noProducts.push(c)
      continue
    }
    targets.push({ ...c, items })
  }

  console.log('3. 補完予定 サマリ')
  console.log(`   候補               : ${candidates.length}`)
  console.log(`   補完対象（確定）   : ${targets.length}`)
  console.log(`   Bカート 商品なし   : ${noProducts.length}`)
  let totalItemCount = 0
  for (const t of targets) totalItemCount += t.items.length
  console.log(`   付与する商品行合計 : ${totalItemCount}`)

  if (targets.length > 0) {
    console.log('\n   サンプル（先頭5件）:')
    for (const t of targets.slice(0, 5)) {
      const dt = t.orderDate.toISOString().slice(0, 10)
      const itemSummary = t.items.slice(0, 3).map((i) => `${i.name}×${i.qty}`).join(', ')
      console.log(`     [${DRY_RUN ? 'DRY' : '更新'}] ${t.docId} | ${dt} | ${t.companyName} | items=${t.items.length}件 | ${itemSummary}${t.items.length > 3 ? ', …' : ''}`)
    }
  }

  if (DRY_RUN) {
    console.log('\n🧪 DRY_RUN: Firestore 書き込みをスキップします。')
    await writeAuditLog({
      mode: 'dry-run', candidateCount: candidates.length, updated: 0, failed: [],
      noProductsCount: noProducts.length, alreadyHasItems, noBcartOrderId,
    })
    process.exit(0)
  }

  if (targets.length === 0) {
    console.log('\n✅ 補完対象なし。終了します。')
    await writeAuditLog({
      mode: 'production', candidateCount: candidates.length, updated: 0, failed: [],
      noProductsCount: noProducts.length, alreadyHasItems, noBcartOrderId,
    })
    process.exit(0)
  }

  console.log(`\n⏳ 本番更新を開始（${BATCH_SIZE}件ずつバッチ）...`)
  const nowTs = FieldValue.serverTimestamp()
  let updated = 0
  const failed = []
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const t of chunk) {
      // items のみ書込。total / dealerCode / companyName 等は無触
      batch.update(t.ref, {
        items: t.items,
        itemsBackfilledAt: nowTs,
        itemsBackfilledBy: OPERATOR,
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

  console.log('\n========================================')
  console.log(`  補完完了`)
  console.log('========================================')
  console.log(`  対象件数            : ${targets.length}`)
  console.log(`  更新件数            : ${updated}`)
  console.log(`  失敗件数            : ${failed.length}`)
  console.log(`  Bカート 商品なし    : ${noProducts.length}`)

  await writeAuditLog({
    mode: 'production', candidateCount: candidates.length, updated, failed,
    noProductsCount: noProducts.length, alreadyHasItems, noBcartOrderId,
  })
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
