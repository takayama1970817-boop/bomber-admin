/**
 * orders 重複 doc 調査スクリプト（read-only / Firestore 書き換えなし）
 *
 * 目的:
 *   2026-04 付近に発見された「同一 bcartCode で Firestore doc が 2 つ存在」
 *   問題の実態を全期間・全代理店で把握する。
 *
 * 絶対ルール:
 *   - Firestore 一切書き換えない
 *   - audit log も書かない（read only 徹底）
 *
 * 使用方法:
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     node scripts/investigate-duplicate-orders.mjs
 *
 * env:
 *   EXPECTED_PROJECT_ID   必須
 *   SERVICE_ACCOUNT_FILE  既定: scripts/service-account.json
 *   SAMPLE_LIMIT          重複サンプル表示件数（既定 10）
 *
 * 出力:
 *   標準出力のみ。機械可読を意識せず人間が読みやすい形で。
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const EXPECTED_PROJECT_ID = process.env.EXPECTED_PROJECT_ID
if (!EXPECTED_PROJECT_ID) {
  console.error('❌ EXPECTED_PROJECT_ID は必須です。')
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
  console.error(`   EXPECTED: ${EXPECTED_PROJECT_ID}`)
  console.error(`   SA       : ${serviceAccount.project_id}`)
  process.exit(1)
}
initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()

const SAMPLE_LIMIT = Number(process.env.SAMPLE_LIMIT || 10)

console.log('========================================')
console.log('  investigate-duplicate-orders.mjs (READ ONLY)')
console.log(`  project_id : ${serviceAccount.project_id}`)
console.log(`  SA file    : ${SA_PATH}`)
console.log('========================================\n')

/** 短い数値 doc ID（外部経路で書かれたと推定される pattern） */
function isShortNumericId(id) {
  return /^\d{1,8}$/.test(String(id))
}

function fmtDate(ts) {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null)
  if (!d || Number.isNaN(d.getTime())) return '?'
  return d.toISOString().slice(0, 10)
}

async function main() {
  console.log('Firestore orders 全件取得中...')
  const snap = await db.collection('orders').get()
  console.log(`  取得: ${snap.size} 件\n`)

  // ==========================================================
  // Pass 1: 基礎分布
  // ==========================================================
  let totalAll = 0
  let depCount = 0
  let validCount = 0
  let hasSyncedAt = 0
  let hasBcartCustomerId = 0
  let shortNumericIds = 0
  let sourceDist = new Map()
  let hasDealerCode = 0
  let emptyDealerCode = 0
  let hasBcartCode = 0
  let hasBcartOrderNumber = 0
  let hasBcartOrderId = 0

  // bcartCode → [docs...]
  const byBcartCode = new Map()
  const byBcartOrderId = new Map()

  for (const d of snap.docs) {
    totalAll++
    const o = d.data()
    if (o.isDeprecated === true) { depCount++; continue }
    validCount++

    if ('syncedAt' in o) hasSyncedAt++
    if ('bcartCustomerId' in o) hasBcartCustomerId++
    if (isShortNumericId(d.id)) shortNumericIds++
    const src = o.source || '(none)'
    sourceDist.set(src, (sourceDist.get(src) || 0) + 1)
    if (String(o.dealerCode || '').trim()) hasDealerCode++
    else emptyDealerCode++
    if (o.bcartCode) hasBcartCode++
    if (o.bcartOrderNumber) hasBcartOrderNumber++
    if (o.bcartOrderId != null) hasBcartOrderId++

    const entry = {
      id: d.id,
      shortId: isShortNumericId(d.id),
      hasSyncedAt: 'syncedAt' in o,
      hasBcartCustomerId: 'bcartCustomerId' in o,
      dealerCode: String(o.dealerCode || '').trim(),
      total: Number(o.total) || 0,
      orderDate: o.orderDate?.toDate?.() || null,
      source: o.source || '',
      createdAt: o.createdAt?.toDate?.() || null,
      companyName: o.companyName || '',
    }
    if (o.bcartCode) {
      const key = String(o.bcartCode)
      if (!byBcartCode.has(key)) byBcartCode.set(key, [])
      byBcartCode.get(key).push(entry)
    }
    if (o.bcartOrderId != null) {
      const key = String(o.bcartOrderId)
      if (!byBcartOrderId.has(key)) byBcartOrderId.set(key, [])
      byBcartOrderId.get(key).push(entry)
    }
  }

  console.log('=== 1. 基礎分布（valid のみ）===')
  console.log(`  全 orders (all) : ${totalAll}`)
  console.log(`  deprecated      : ${depCount}`)
  console.log(`  valid           : ${validCount}`)
  console.log(`  dealerCode あり : ${hasDealerCode}`)
  console.log(`  dealerCode 空   : ${emptyDealerCode}`)
  console.log(`  bcartCode あり  : ${hasBcartCode}`)
  console.log(`  bcartOrderNumber: ${hasBcartOrderNumber}`)
  console.log(`  bcartOrderId    : ${hasBcartOrderId}`)
  console.log(`  syncedAt フィールドあり  : ${hasSyncedAt}`)
  console.log(`  bcartCustomerId フィールドあり: ${hasBcartCustomerId}`)
  console.log(`  doc ID が短い数値       : ${shortNumericIds}`)
  console.log(`  source 分布:`)
  for (const [s, c] of [...sourceDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(12)}: ${c}`)
  }

  // ==========================================================
  // Pass 2: bcartCode 重複分析
  // ==========================================================
  console.log('\n=== 2. bcartCode 重複 ===')
  let dupBcartCodeGroups = 0
  let dupBcartCodeDocs = 0
  let totalMismatchGroups = 0
  let deprecatedCandidateDocs = 0
  let deprecatedCandidateTotalSum = 0
  let sampleCount = 0
  const yearlyDup = new Map()
  const sampleDups = []
  const samplesMismatch = []
  const samplesBothValidAndDealer = []

  for (const [code, docs] of byBcartCode.entries()) {
    if (docs.length < 2) continue
    dupBcartCodeGroups++
    dupBcartCodeDocs += docs.length

    // total 一致チェック
    const totals = [...new Set(docs.map((d) => d.total))]
    if (totals.length > 1) {
      totalMismatchGroups++
      if (samplesMismatch.length < 5) {
        samplesMismatch.push({ code, docs: docs.map((d) => ({ id: d.id, total: d.total, dealerCode: d.dealerCode, shortId: d.shortId })) })
      }
    }

    // 典型パターン: 片方 syncedAt 系 (短い数値 ID)・片方は bcart-sync 系
    const withSyncedAt = docs.filter((d) => d.hasSyncedAt || d.shortId)
    const withDealer = docs.filter((d) => d.dealerCode)
    if (withSyncedAt.length > 0 && withDealer.length > 0) {
      // deprecated 候補: syncedAt / 短い数値 ID 側
      for (const sd of withSyncedAt) {
        if (!withDealer.find((x) => x.id === sd.id)) {
          deprecatedCandidateDocs++
          deprecatedCandidateTotalSum += sd.total
        }
      }
    }

    // 両方 dealerCode ありかつ両方 valid → 警告
    if (withDealer.length >= 2 && withDealer.length === docs.length) {
      if (samplesBothValidAndDealer.length < 5) {
        samplesBothValidAndDealer.push({ code, docs })
      }
    }

    // 年別
    const y = docs[0]?.orderDate?.getFullYear() || '?'
    yearlyDup.set(y, (yearlyDup.get(y) || 0) + 1)

    if (sampleCount < SAMPLE_LIMIT) {
      sampleDups.push({ code, docs })
      sampleCount++
    }
  }

  console.log(`  重複 bcartCode グループ数      : ${dupBcartCodeGroups}`)
  console.log(`  重複 doc 総数                  : ${dupBcartCodeDocs}`)
  console.log(`  うち total 不一致グループ      : ${totalMismatchGroups}`)
  console.log(`  deprecated 化候補（syncedAt/短ID 側）: ${deprecatedCandidateDocs}`)
  console.log(`  deprecated 候補の total 合計   : ¥${deprecatedCandidateTotalSum.toLocaleString()}`)

  console.log(`\n  重複グループ 年別分布:`)
  for (const y of [...yearlyDup.keys()].sort()) {
    console.log(`    ${y}: ${yearlyDup.get(y)} グループ`)
  }

  console.log(`\n  サンプル重複グループ (先頭 ${Math.min(SAMPLE_LIMIT, sampleDups.length)} 件):`)
  for (const { code, docs } of sampleDups) {
    console.log(`    bcartCode=${code}:`)
    for (const d of docs) {
      const flag = [
        d.shortId ? 'shortId' : '',
        d.hasSyncedAt ? 'syncedAt' : '',
        d.hasBcartCustomerId ? 'bcartCustomerId' : '',
      ].filter(Boolean).join(',')
      console.log(`      ${d.id.padEnd(22)} | dealer=${(d.dealerCode || '(空)').padEnd(6)} | total=¥${d.total.toLocaleString().padStart(10)} | ${fmtDate(d.orderDate)} | ${flag}`)
    }
  }

  if (samplesMismatch.length) {
    console.log(`\n  ⚠️  total 不一致サンプル（要手動判断）:`)
    for (const { code, docs } of samplesMismatch) {
      console.log(`    bcartCode=${code}:`)
      for (const d of docs) console.log(`      ${d.id} | dealer=${d.dealerCode || '(空)'} | total=¥${d.total.toLocaleString()} | shortId=${d.shortId}`)
    }
  }
  if (samplesBothValidAndDealer.length) {
    console.log(`\n  ⚠️  同一 bcartCode で両方 dealerCode あり（要手動判断）:`)
    for (const { code, docs } of samplesBothValidAndDealer) {
      console.log(`    bcartCode=${code}: ${docs.map((d) => `${d.id}(dealer=${d.dealerCode})`).join(' / ')}`)
    }
  }

  // ==========================================================
  // Pass 3: syncedAt 系の時系列分布（いつから入り始めたか）
  // ==========================================================
  console.log('\n=== 3. syncedAt フィールドあり doc の createdAt 分布（月別）===')
  const syncedAtByMonth = new Map()
  for (const d of snap.docs) {
    const o = d.data()
    if (o.isDeprecated === true) continue
    if (!('syncedAt' in o)) continue
    const ca = o.createdAt?.toDate?.() || o.syncedAt?.toDate?.()
    const key = ca ? `${ca.getFullYear()}-${String(ca.getMonth() + 1).padStart(2, '0')}` : '(none)'
    syncedAtByMonth.set(key, (syncedAtByMonth.get(key) || 0) + 1)
  }
  for (const k of [...syncedAtByMonth.keys()].sort()) {
    console.log(`  ${k}: ${syncedAtByMonth.get(k)}`)
  }

  // ==========================================================
  // Pass 4: dealerCode 欠落 内訳（重複解消後の真の backfill 対象）
  // ==========================================================
  console.log('\n=== 4. dealerCode 欠落 の内訳（重複解消シミュレーション）===')
  let emptyDealer_inDup_deprecatedSide = 0 // 重複ありかつ syncedAt/短ID 側 = cleanup で消える
  let emptyDealer_inDup_otherSide = 0      // 重複ありだが別の面 = 要確認
  let emptyDealer_notDup = 0               // 重複なしの真の欠落

  for (const [code, docs] of byBcartCode.entries()) {
    const emptyDocs = docs.filter((d) => !d.dealerCode)
    if (emptyDocs.length === 0) continue
    if (docs.length === 1) {
      emptyDealer_notDup += emptyDocs.length
      continue
    }
    // 重複ありの場合
    const withDealerExists = docs.some((d) => d.dealerCode)
    for (const e of emptyDocs) {
      if (withDealerExists && (e.shortId || e.hasSyncedAt)) emptyDealer_inDup_deprecatedSide++
      else emptyDealer_inDup_otherSide++
    }
  }
  console.log(`  重複ペアで syncedAt/短ID 側 (= cleanup で消える): ${emptyDealer_inDup_deprecatedSide}`)
  console.log(`  重複ペアだが syncedAt 系以外の欠落            : ${emptyDealer_inDup_otherSide}`)
  console.log(`  重複なしの真の欠落 (要 backfill)              : ${emptyDealer_notDup}`)

  // ==========================================================
  // Pass 5: 真に backfill が必要な件数のサマリ
  // ==========================================================
  const trueBackfillNeeded = emptyDealer_notDup + emptyDealer_inDup_otherSide
  console.log('\n=== 5. 最終サマリ ===')
  console.log(`  cleanup (deprecated化) 候補     : ${deprecatedCandidateDocs} 件 / ¥${deprecatedCandidateTotalSum.toLocaleString()}`)
  console.log(`  cleanup 後に残る dealerCode 欠落: ${trueBackfillNeeded} 件`)
  console.log(`    = 真に backfill が必要な件数`)
  console.log('')

  // bcartOrderId でも重複チェック（念のため）
  const dupByOrderId = [...byBcartOrderId.values()].filter((v) => v.length >= 2)
  console.log(`  [参考] bcartOrderId 重複グループ: ${dupByOrderId.length}`)

  process.exit(0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
