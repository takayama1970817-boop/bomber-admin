/**
 * cutover 実行スクリプト：既存 `orders` を readOnly 化（Admin SDK 版）
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §7
 *
 * 目的:
 *   ERP 新構造（erp_orders）への切替日（cutoverDate）当日に実行する。
 *   既存 orders 全件に `isDeprecated: true` と `deprecatedAt` を付与。
 *   以降、orders コレクションは「参照のみ」扱いとする（rules で update を制限）。
 *
 * 前提:
 *   1. Phase 1 Step 1〜4 の実装完了
 *   2. BcartImport を erp_orders 対応化（または取込停止運用）→ 実運用では別途作業
 *   3. scripts/service-account.json に Firebase Admin SDK 秘密鍵を配置
 *
 * 使用方法:
 *   # DRY RUN（確認のみ、何も書き込まない）
 *   node scripts/cutover-orders.mjs
 *
 *   # 本番実行（監査ログ付き、社長判断で実行）
 *   DRY_RUN=false OPERATOR="社長 ボンバー" node scripts/cutover-orders.mjs
 *
 *   # 特定 company のみ対象（任意）
 *   COMPANY=rt DRY_RUN=false node scripts/cutover-orders.mjs
 *
 * 出力:
 *   - 標準出力: 対象件数 / サンプル / 失敗詳細
 *   - Firestore: cutoverLogs/{auto-id} に実行記録
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)
if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const COMPANY_FILTER = process.env.COMPANY || null // 'rt' | 'rc' | null（全件）
const LOG_COLLECTION = 'cutoverLogs'
const BATCH_SIZE = 400 // Firestore 500件制限に余裕を持たせる

async function fetchTargets() {
  let q = db.collection('orders')
  if (COMPANY_FILTER) {
    // orders に company field が入っていない古いデータも存在しうるので片方ずつ調査推奨
    q = q.where('company', '==', COMPANY_FILTER)
  }
  const snap = await q.get()
  // 既に isDeprecated=true になっているものは除外（再実行安全）
  return snap.docs.filter((d) => d.data().isDeprecated !== true)
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
      targetCount,
      updatedCount: updated,
      failedCount: failed.length,
      failedIds: failed.map((f) => f.id).slice(0, 200),
      scriptVersion: '2026-04-18.v1',
    })
    console.log(`\n📝 監査ログ保存: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗（処理自体は完了）:', e.message)
    return null
  }
}

async function main() {
  if (DRY_RUN) {
    console.log('🧪 DRY RUN モード（実際には更新しません）')
    console.log('   本番: DRY_RUN=false OPERATOR="署名" node scripts/cutover-orders.mjs\n')
  } else {
    console.log('⚠️  本番モード：既存 orders 全件に isDeprecated=true を付与します')
    console.log(`   OPERATOR=${OPERATOR}`)
    console.log(`   COMPANY=${COMPANY_FILTER || 'all'}\n`)
  }

  console.log('🔍 対象受注を集計中...')
  const targets = await fetchTargets()
  console.log(`  対象: ${targets.length} 件（既に isDeprecated=true のものはスキップ済）`)

  if (targets.length === 0) {
    console.log('\n✅ 対象なし。全件 cutover 済みです。')
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

  // 検証：isDeprecated=false が残っていないか
  console.log('\n🔍 検証: isDeprecated 未設定が残っていないか...')
  const remain = await fetchTargets()
  if (remain.length === 0) {
    console.log('  ✅ isDeprecated 未設定 0件')
  } else {
    console.log(`  ⚠️  未設定 ${remain.length} 件残存 — 再実行してください`)
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
