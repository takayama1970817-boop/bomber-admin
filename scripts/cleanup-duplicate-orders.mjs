/**
 * orders 重複 doc クリーンアップスクリプト（Admin SDK 版）
 *
 * 目的:
 *   PR #57 の投資結果で判明した「同一 bcartCode で 2 doc 並走」問題を
 *   安全に解消する。対象は syncedAt 系（本プロジェクト外の経路で書かれた）
 *   の重複片側のみで、isDeprecated=true を付与する論理削除。
 *
 * 絶対ルール（社長承認・2026-04-24）:
 *   - 対象条件の AND を全て満たす doc のみ deprecated 化:
 *       1. 同一 bcartCode で valid doc が「ちょうど 2 件」
 *       2. 片方 dealerCode あり、片方 dealerCode 空
 *       3. dealerCode 空 doc が syncedAt 系
 *          （syncedAt フィールドあり or doc ID が短い数値 [1-8桁]）
 *       4. 両 doc の total が完全一致
 *   - 単独 syncedAt 系（ペアなし 15,304 件）は絶対に触らない
 *   - total 不一致 / 両方 dealerCode あり / 両方 dealerCode 空 /
 *     3件以上の重複 は自動処理しない（手動判断にエスカレーション）
 *   - total / dealerCode / companyName / orderDate 等は一切書き換えない
 *   - 既定 DRY_RUN（書き込みは DRY_RUN=false 明示時のみ）
 *
 * 書き込みフィールド（deprecated 化時のみ、additive）:
 *   - isDeprecated: true
 *   - deprecatedAt: serverTimestamp
 *   - deprecatedBy: OPERATOR
 *   - deprecatedReason: 'duplicate-cleanup-syncedAt-variant'
 *
 * 使用方法:
 *   # DRY_RUN（書き込みなし）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     node scripts/cleanup-duplicate-orders.mjs
 *
 *   # 本番実行（DRY_RUN 結果確認後）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     DRY_RUN=false OPERATOR="社長 ボンバー" \
 *     node scripts/cleanup-duplicate-orders.mjs
 *
 *   # 2 回目以降（通常ブロックされる）
 *   FORCE_RERUN=true DRY_RUN=false ... node scripts/cleanup-duplicate-orders.mjs
 *
 * env:
 *   EXPECTED_PROJECT_ID   必須
 *   SERVICE_ACCOUNT_FILE  既定: scripts/service-account.json
 *   DRY_RUN               'false' 以外は DRY
 *   OPERATOR              本番実行時必須
 *   FORCE_RERUN           'true' で二度打ち override
 *
 * 出力:
 *   標準出力: 対象件数 / 除外件数（種別ごと）/ 代理店別内訳 / サンプル
 *   Firestore: orderCleanupLogs/{auto-id} に監査ログ（本番実行時 + DRY_RUN どちらも）
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

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

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const FORCE_RERUN = process.env.FORCE_RERUN === 'true'
const LOG_COLLECTION = 'orderCleanupLogs'
const BATCH_SIZE = 400
const SCRIPT_VERSION = '2026-04-24.v1'
const DEPRECATED_REASON = 'duplicate-cleanup-syncedAt-variant'

if (!DRY_RUN && OPERATOR === 'unknown') {
  console.error('❌ 本番実行時は OPERATOR が必須です。')
  console.error('   例: OPERATOR="社長 ボンバー" DRY_RUN=false ...')
  process.exit(1)
}

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()

console.log('========================================')
console.log('  cleanup-duplicate-orders.mjs')
console.log(`  project_id     : ${serviceAccount.project_id}`)
console.log(`  client_email   : ${serviceAccount.client_email}`)
console.log(`  SA file        : ${SA_PATH}`)
console.log(`  mode           : ${DRY_RUN ? 'DRY_RUN（書き込みなし）' : '本番'}`)
console.log(`  operator       : ${OPERATOR}`)
console.log(`  FORCE_RERUN    : ${FORCE_RERUN}`)
console.log(`  script version : ${SCRIPT_VERSION}`)
console.log('========================================\n')

/** 短い数値 doc ID（外部経路で書かれた syncedAt 系と推定） */
function isShortNumericId(id) {
  return /^\d{1,8}$/.test(String(id))
}

/** syncedAt 系 doc かどうか判定 */
function isSyncedAtVariant(doc, data) {
  return ('syncedAt' in data) || isShortNumericId(doc.id)
}

function fmtDate(ts) {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null)
  if (!d || Number.isNaN(d.getTime())) return '?'
  return d.toISOString().slice(0, 10)
}

async function hasPreviousProductionRun() {
  try {
    const snap = await db.collection(LOG_COLLECTION)
      .where('type', '==', 'orders-duplicate-cleanup')
      .where('mode', '==', 'production')
      .get()
    return snap.docs.some((d) => (d.data().updatedCount || 0) > 0)
  } catch (e) {
    console.warn('⚠️  orderCleanupLogs 照会失敗（二度打ちチェックスキップ）:', e.message)
    return false
  }
}

/**
 * 対象（targets）と除外理由別の内訳（skips）を返す。
 * targets: [{ ref, docId, bcartCode, total, orderDate, dealerCode, companyName }]
 * skips: { totalMismatch: [], bothDealer: [], bothEmpty: [], triplePlus: [], soloEmptyButNotSyncedAt: [], ... }
 */
function classifyGroups(byBcartCode) {
  const targets = []
  const skips = {
    totalMismatch: [],         // total 不一致（自動処理不可）
    bothDealer: [],            // 両方 dealerCode あり（自動処理不可）
    bothEmpty: [],             // 両方 dealerCode 空（手動判断）
    triplePlus: [],            // 3 件以上の重複（想定外）
    emptySideNotSyncedAt: [],  // dealerCode 空側が syncedAt 系でない（安全側にスキップ）
    singleDoc: 0,              // 重複なし（対象外・カウントのみ）
  }
  for (const [code, docs] of byBcartCode.entries()) {
    if (docs.length === 1) { skips.singleDoc++; continue }
    if (docs.length >= 3) {
      skips.triplePlus.push({ code, count: docs.length })
      continue
    }
    // 重複 2 件の場合のみ判定
    const [a, b] = docs
    // total 一致チェック
    if (a.total !== b.total) {
      skips.totalMismatch.push({ code, docs: [a, b] })
      continue
    }
    const aHas = !!a.dealerCode
    const bHas = !!b.dealerCode
    if (aHas && bHas) { skips.bothDealer.push({ code, docs: [a, b] }); continue }
    if (!aHas && !bHas) { skips.bothEmpty.push({ code, docs: [a, b] }); continue }
    // 片方あり、片方空
    const empty = aHas ? b : a
    const full = aHas ? a : b
    if (!empty.isSyncedAtVariant) {
      skips.emptySideNotSyncedAt.push({ code, empty, full })
      continue
    }
    // 条件すべてクリア → deprecated 対象
    targets.push({
      code,
      empty,      // これを deprecated 化
      full,      // これは残す（参考情報）
    })
  }
  return { targets, skips }
}

async function writeAuditLog({ mode, targetCount, updated, failed, skips }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'orders-duplicate-cleanup',
      mode,
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      expectedProjectId: EXPECTED_PROJECT_ID,
      targetCount,
      updatedCount: updated,
      failedCount: failed.length,
      failedIds: failed.map((f) => f.id).slice(0, 200),
      skipCounts: {
        totalMismatch: skips.totalMismatch.length,
        bothDealer: skips.bothDealer.length,
        bothEmpty: skips.bothEmpty.length,
        triplePlus: skips.triplePlus.length,
        emptySideNotSyncedAt: skips.emptySideNotSyncedAt.length,
      },
      deprecatedReason: DEPRECATED_REASON,
      scriptVersion: SCRIPT_VERSION,
    })
    console.log(`\n📝 監査ログ保存: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗（処理自体は完了）:', e.message)
    return null
  }
}

async function main() {
  // 二度打ち防止
  const hadPrevious = await hasPreviousProductionRun()
  if (hadPrevious) {
    if (!DRY_RUN && !FORCE_RERUN) {
      console.error('❌ 過去に本番実行済みです（orderCleanupLogs に production 履歴あり）。')
      console.error('   本当に再実行が必要な場合のみ FORCE_RERUN=true を付けてください。')
      process.exit(1)
    }
    console.log(`ℹ️  orderCleanupLogs に本番実行履歴あり（FORCE_RERUN=${FORCE_RERUN}）`)
  } else {
    console.log('ℹ️  orderCleanupLogs に本番実行履歴なし（初回実行相当）')
  }

  // 1. orders 全件読込 → bcartCode でグループ化
  console.log('\n1. Firestore orders 読込中...')
  const snap = await db.collection('orders').get()
  const byBcartCode = new Map()
  let depCount = 0, validCount = 0
  for (const d of snap.docs) {
    const data = d.data()
    if (data.isDeprecated === true) { depCount++; continue }
    validCount++
    const code = data.bcartCode || data.bcartOrderNumber || null
    if (!code) continue
    if (!byBcartCode.has(code)) byBcartCode.set(code, [])
    byBcartCode.get(code).push({
      ref: d.ref,
      docId: d.id,
      bcartCode: code,
      total: Number(data.total) || 0,
      orderDate: data.orderDate?.toDate?.() || null,
      dealerCode: String(data.dealerCode || '').trim(),
      companyName: data.companyName || '',
      isSyncedAtVariant: isSyncedAtVariant(d, data),
    })
  }
  console.log(`  取得: ${snap.size} 件 / valid=${validCount} / deprecated=${depCount}`)

  // 2. 重複グループ分類
  console.log('\n2. 重複グループ分類中...')
  const { targets, skips } = classifyGroups(byBcartCode)

  console.log(`  重複なし（単独 doc）           : ${skips.singleDoc}`)
  console.log(`  重複 2 件・対象確定           : ${targets.length}`)
  console.log(`  --- 以下はスキップ（自動処理しない）---`)
  console.log(`  total 不一致                  : ${skips.totalMismatch.length}`)
  console.log(`  両方 dealerCode あり          : ${skips.bothDealer.length}`)
  console.log(`  両方 dealerCode 空            : ${skips.bothEmpty.length}`)
  console.log(`  3 件以上の重複                : ${skips.triplePlus.length}`)
  console.log(`  dealerCode 空だが非 syncedAt 系: ${skips.emptySideNotSyncedAt.length}`)

  // スキップグループのサンプル表示（最大 5 件ずつ）
  function showSample(label, arr) {
    if (arr.length === 0) return
    console.log(`\n  [${label}] サンプル（先頭 ${Math.min(5, arr.length)} 件）:`)
    for (const item of arr.slice(0, 5)) {
      if (item.docs) {
        console.log(`    bcartCode=${item.code}:`)
        for (const d of item.docs) console.log(`      ${d.docId} | dealer=${d.dealerCode || '(空)'} | total=¥${d.total.toLocaleString()}`)
      } else if (item.empty && item.full) {
        console.log(`    bcartCode=${item.code}:`)
        console.log(`      ${item.empty.docId} | dealer=(空) | total=¥${item.empty.total.toLocaleString()} | syncedAt=${item.empty.isSyncedAtVariant}`)
        console.log(`      ${item.full.docId} | dealer=${item.full.dealerCode} | total=¥${item.full.total.toLocaleString()}`)
      } else {
        console.log(`    bcartCode=${item.code} | count=${item.count}`)
      }
    }
  }
  showSample('total 不一致', skips.totalMismatch)
  showSample('両方 dealerCode あり', skips.bothDealer)
  showSample('両方 dealerCode 空', skips.bothEmpty)
  showSample('3 件以上の重複', skips.triplePlus)
  showSample('dealerCode 空だが非 syncedAt 系', skips.emptySideNotSyncedAt)

  // 3. 対象サマリ + 代理店別内訳
  if (targets.length === 0) {
    console.log('\n✅ 対象なし。終了します。')
    await writeAuditLog({ mode: DRY_RUN ? 'dry-run' : 'production', targetCount: 0, updated: 0, failed: [], skips })
    process.exit(0)
  }

  const byDealer = new Map()
  let depTotalSum = 0
  for (const t of targets) {
    const code = t.full.dealerCode
    if (!byDealer.has(code)) byDealer.set(code, { count: 0, total: 0 })
    const e = byDealer.get(code)
    e.count++
    e.total += t.empty.total
    depTotalSum += t.empty.total
  }
  console.log(`\n3. deprecated 化候補 サマリ`)
  console.log(`  対象件数            : ${targets.length}`)
  console.log(`  消える side の total合計: ¥${depTotalSum.toLocaleString()} （集計への実質影響は 0 円）`)
  console.log(`  代理店別内訳（正本側 dealerCode）:`)
  const sortedByDealer = [...byDealer.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [code, e] of sortedByDealer) {
    console.log(`    ${code}: ${e.count} 件 / ¥${e.total.toLocaleString()}`)
  }

  console.log(`\n  サンプル（先頭 5 件）:`)
  for (const t of targets.slice(0, 5)) {
    console.log(`    bcartCode=${t.code}:`)
    console.log(`      [${DRY_RUN ? 'DRY' : '更新'}] ${t.empty.docId} | 消す side | total=¥${t.empty.total.toLocaleString()} | ${fmtDate(t.empty.orderDate)}`)
    console.log(`      (残す)    ${t.full.docId} | dealer=${t.full.dealerCode} | total=¥${t.full.total.toLocaleString()}`)
  }

  // 4. DRY_RUN or 本番
  let updated = 0
  const failed = []
  if (DRY_RUN) {
    console.log('\n🧪 DRY_RUN のため Firestore 書き込みはスキップします。')
  } else {
    console.log(`\n⏳ 本番更新を開始（${BATCH_SIZE}件ずつバッチ）...`)
    const nowTs = FieldValue.serverTimestamp()
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const chunk = targets.slice(i, i + BATCH_SIZE)
      const batch = db.batch()
      for (const t of chunk) {
        // total / dealerCode / companyName / orderDate 等は一切触らない。
        // isDeprecated 系 4 フィールドのみ additive に追加。
        batch.update(t.empty.ref, {
          isDeprecated: true,
          deprecatedAt: nowTs,
          deprecatedBy: OPERATOR,
          deprecatedReason: DEPRECATED_REASON,
        })
      }
      try {
        await batch.commit()
        updated += chunk.length
        console.log(`  ✓ ${updated} / ${targets.length} 件 完了`)
      } catch (e) {
        console.error(`  ❌ batch 失敗 (offset=${i}):`, e.message)
        failed.push(...chunk.map((t) => ({ id: t.empty.docId, error: e.message })))
      }
    }
  }

  // 5. 監査ログ + サマリ
  console.log('\n========================================')
  console.log(`  ${DRY_RUN ? '【DRY_RUN】想定結果' : 'cleanup 完了'}`)
  console.log('========================================')
  console.log(`  対象件数            : ${targets.length}`)
  if (!DRY_RUN) {
    console.log(`  更新件数            : ${updated}`)
    console.log(`  失敗件数            : ${failed.length}`)
  }
  console.log(`  スキップ（手動判断）: ${
    skips.totalMismatch.length + skips.bothDealer.length + skips.bothEmpty.length +
    skips.triplePlus.length + skips.emptySideNotSyncedAt.length
  }`)

  await writeAuditLog({
    mode: DRY_RUN ? 'dry-run' : 'production',
    targetCount: targets.length,
    updated,
    failed,
    skips,
  })

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
