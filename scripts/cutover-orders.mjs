/**
 * cutover 実行スクリプト：既存 `orders` を readOnly 化（Admin SDK 版）
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §7
 *
 * 目的:
 *   ERP 新構造（erp_orders）への切替日（cutoverDate）当日に実行する。
 *   cutoff 日付以前の orders に `isDeprecated: true` と `deprecatedAt` を付与。
 *   以降、orders コレクションは「参照のみ」扱いとする（rules で update を制限）。
 *
 * 安全策（2026-04-24 追加 / PR #55）:
 *   - EXPECTED_PROJECT_ID 必須     : service-account.json の project_id と不一致なら exit
 *   - CUTOVER_BEFORE=YYYY-MM-DD 必須: orderDate < 指定日 のみ対象（巻き添え防止）
 *   - 二度打ち防止                 : cutoverLogs に production 履歴があれば本番実行を拒否
 *                                    （FORCE_RERUN=true で override 可）
 *   - 起動時ログ強化               : project_id / client_email / cutoff / 履歴件数を表示
 *
 * 前提:
 *   1. Phase 1 Step 1〜4 の実装完了
 *   2. BcartImport を erp_orders 対応化（または取込停止運用）→ 実運用では別途作業
 *   3. scripts/service-account.json に Firebase Admin SDK 秘密鍵を配置
 *
 * 使用方法:
 *   # DRY RUN（確認のみ、何も書き込まない）
 *   EXPECTED_PROJECT_ID=bomber-admin CUTOVER_BEFORE=2026-04-18 \
 *     node scripts/cutover-orders.mjs
 *
 *   # 本番実行（監査ログ付き、社長判断で実行）
 *   EXPECTED_PROJECT_ID=bomber-admin CUTOVER_BEFORE=2026-04-18 \
 *     DRY_RUN=false OPERATOR="社長 ボンバー" \
 *     node scripts/cutover-orders.mjs
 *
 *   # 本番 2回目以降（通常はブロック。本当に必要な場合のみ）
 *   FORCE_RERUN=true DRY_RUN=false ... node scripts/cutover-orders.mjs
 *
 * 出力:
 *   - 標準出力: 対象件数 / サンプル / 失敗詳細
 *   - Firestore: cutoverLogs/{auto-id} に実行記録
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)
if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))

// === 必須 env ガード ===
const EXPECTED_PROJECT_ID = process.env.EXPECTED_PROJECT_ID
if (!EXPECTED_PROJECT_ID) {
  console.error('❌ EXPECTED_PROJECT_ID は必須です（誤実行防止）。')
  console.error('   例: EXPECTED_PROJECT_ID=bomber-admin-test （テスト）')
  console.error('       EXPECTED_PROJECT_ID=bomber-admin      （本番）')
  process.exit(1)
}
if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  console.error('❌ project_id 不一致のため停止します（誤実行防止）。')
  console.error(`   EXPECTED_PROJECT_ID : ${EXPECTED_PROJECT_ID}`)
  console.error(`   service account     : ${serviceAccount.project_id}`)
  console.error(`   service account file: ${SERVICE_ACCOUNT_PATH}`)
  process.exit(1)
}

const CUTOVER_BEFORE = process.env.CUTOVER_BEFORE
if (!CUTOVER_BEFORE) {
  console.error('❌ CUTOVER_BEFORE=YYYY-MM-DD は必須です（巻き添え防止）。')
  console.error('   orderDate < 指定日 の orders のみを対象にする境界。')
  console.error('   例: CUTOVER_BEFORE=2026-04-18')
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOVER_BEFORE)) {
  console.error(`❌ CUTOVER_BEFORE の形式が不正: "${CUTOVER_BEFORE}" (期待: YYYY-MM-DD)`)
  process.exit(1)
}
const CUTOFF_DATE = new Date(`${CUTOVER_BEFORE}T00:00:00+09:00`)
if (Number.isNaN(CUTOFF_DATE.getTime())) {
  console.error(`❌ CUTOVER_BEFORE のパースに失敗: "${CUTOVER_BEFORE}"`)
  process.exit(1)
}

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const COMPANY_FILTER = process.env.COMPANY || null // 'rt' | 'rc' | null（全件）
const FORCE_RERUN = process.env.FORCE_RERUN === 'true'
const LOG_COLLECTION = 'cutoverLogs'
const BATCH_SIZE = 400 // Firestore 500件制限に余裕を持たせる

console.log('========================================')
console.log('  cutover-orders.mjs')
console.log(`  project_id        : ${serviceAccount.project_id}`)
console.log(`  client_email      : ${serviceAccount.client_email}`)
console.log(`  CUTOVER_BEFORE    : ${CUTOVER_BEFORE} (orderDate < ${CUTOFF_DATE.toISOString()})`)
console.log(`  mode              : ${DRY_RUN ? 'DRY_RUN' : '本番'}`)
console.log(`  operator          : ${OPERATOR}`)
console.log(`  company filter    : ${COMPANY_FILTER || 'all'}`)
console.log(`  FORCE_RERUN       : ${FORCE_RERUN}`)
console.log('========================================\n')

async function fetchTargets() {
  let q = db.collection('orders')
  if (COMPANY_FILTER) {
    // ⚠️ 古いデータで company field 未設定のものは対象外になる。
    //    注意喚起のためログにも出す。
    console.warn(`⚠️  COMPANY フィルタ有効: where('company', '==', '${COMPANY_FILTER}')`)
    console.warn('   company field が未設定の doc は対象外になります。')
    q = q.where('company', '==', COMPANY_FILTER)
  }
  // orderDate < CUTOFF_DATE のみ対象
  q = q.where('orderDate', '<', Timestamp.fromDate(CUTOFF_DATE))
  const snap = await q.get()
  // 既に isDeprecated=true のものは除外（再実行安全）
  return snap.docs.filter((d) => d.data().isDeprecated !== true)
}

/** cutoverLogs に過去の本番実行履歴があるか確認（二度打ち防止用） */
async function hasPreviousProductionRun() {
  try {
    const snap = await db.collection(LOG_COLLECTION)
      .where('type', '==', 'orders-cutover')
      .where('mode', '==', 'production')
      .get()
    // updatedCount > 0 の履歴を本番実行とみなす
    return snap.docs.some((d) => (d.data().updatedCount || 0) > 0)
  } catch (e) {
    console.warn('⚠️  cutoverLogs 照会失敗（二度打ちチェックスキップ）:', e.message)
    return false
  }
}

async function writeAuditLog({ mode, targetCount, updated, failed, deprecatedAt }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'orders-cutover',
      mode,
      runAt: FieldValue.serverTimestamp(),
      deprecatedAt, // スクリプト実行時刻と同じ（serverTimestamp）
      operator: OPERATOR,
      companyFilter: COMPANY_FILTER || 'all',
      cutoverBefore: CUTOVER_BEFORE,
      expectedProjectId: EXPECTED_PROJECT_ID,
      targetCount,
      updatedCount: updated,
      failedCount: failed.length,
      failedIds: failed.map((f) => f.id).slice(0, 200),
      scriptVersion: '2026-04-24.v2',
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
      console.error('❌ 過去に本番実行済みです（cutoverLogs に production 履歴あり）。')
      console.error('   本当に再実行が必要な場合のみ FORCE_RERUN=true を付けてください。')
      process.exit(1)
    }
    console.log(`ℹ️  cutoverLogs に本番実行履歴あり（FORCE_RERUN=${FORCE_RERUN}）`)
  } else {
    console.log('ℹ️  cutoverLogs に本番実行履歴なし（初回実行相当）')
  }

  if (DRY_RUN) {
    console.log('🧪 DRY RUN モード（実際には更新しません）')
    console.log('   本番: DRY_RUN=false OPERATOR="署名" node scripts/cutover-orders.mjs\n')
  } else {
    console.log('⚠️  本番モード：対象 orders に isDeprecated=true を付与します\n')
  }

  console.log('🔍 対象受注を集計中...')
  const targets = await fetchTargets()
  console.log(`  対象: ${targets.length} 件（orderDate < ${CUTOVER_BEFORE} かつ isDeprecated 未設定）`)

  if (targets.length === 0) {
    console.log('\n✅ 対象なし。全件 cutover 済み、または境界以降のデータのみです。')
    if (!DRY_RUN) {
      await writeAuditLog({ mode: 'production', targetCount: 0, updated: 0, failed: [], deprecatedAt: null })
    }
    process.exit(0)
  }

  // サンプル表示（最初の5件）
  console.log('\n--- サンプル（最初の5件）---')
  for (const d of targets.slice(0, 5)) {
    const data = d.data()
    const oDate = data.orderDate?.toDate ? data.orderDate.toDate().toISOString().slice(0, 10) : '?'
    const hint = data.companyName || data.orderNumber || data.bcartOrderNumber || ''
    console.log(`  [${DRY_RUN ? 'DRY' : '更新'}] ${d.id}  orderDate=${oDate}  ${hint}`)
  }
  if (targets.length > 5) console.log(`  ... 他 ${targets.length - 5} 件`)

  if (DRY_RUN) {
    console.log(`\n✅ [DRY RUN] ${targets.length} 件が対象。本番実行するには DRY_RUN=false を付けてください`)
    await writeAuditLog({ mode: 'dry-run', targetCount: targets.length, updated: 0, failed: [], deprecatedAt: null })
    process.exit(0)
  }

  // 本番更新（writeBatch で 400件ずつ）
  console.log(`\n⏳ 本番更新を開始します（${BATCH_SIZE}件ずつバッチ書き込み）...`)
  const deprecatedAt = FieldValue.serverTimestamp()
  let updated = 0
  const failed = []

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const d of chunk) {
      batch.update(d.ref, {
        isDeprecated: true,
        deprecatedAt,
        deprecatedBy: OPERATOR,
      })
    }
    try {
      await batch.commit()
      updated += chunk.length
      console.log(`  ✓ ${updated} / ${targets.length} 件 完了`)
    } catch (e) {
      console.error(`  ❌ batch 失敗 (offset=${i}):`, e.message)
      failed.push(...chunk.map((d) => ({ id: d.id, error: e.message })))
    }
  }

  console.log(`\n✅ 更新完了: ${updated} 件 / 失敗: ${failed.length} 件`)
  if (failed.length > 0) {
    console.log('--- 失敗 ID（最初の20件）---')
    for (const f of failed.slice(0, 20)) console.log(`  ${f.id}: ${f.error}`)
  }

  await writeAuditLog({ mode: 'production', targetCount: targets.length, updated, failed, deprecatedAt: new Date().toISOString() })

  // 検証：isDeprecated=false が残っていないか（CUTOVER_BEFORE 境界内で）
  console.log('\n🔍 検証: 境界内の isDeprecated 未設定が残っていないか...')
  const remain = await fetchTargets()
  if (remain.length === 0) {
    console.log('  ✅ 境界内の isDeprecated 未設定 0件')
  } else {
    console.log(`  ⚠️  未設定 ${remain.length} 件残存 — 再実行してください`)
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
