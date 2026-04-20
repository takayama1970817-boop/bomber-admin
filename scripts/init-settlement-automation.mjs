/**
 * init-settlement-automation.mjs
 *
 * Phase 2 段階1 の初期化スクリプト。
 * settings/settlement_automation ドキュメントを enabled=false で初期作成する。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §1.9
 *
 * 前提:
 *   - scripts/service-account.json が配置されていること
 *   - Firebase Admin SDK でプロジェクトに接続できること
 *
 * 使い方:
 *   # dry-run（書き込みなし）
 *   node scripts/init-settlement-automation.mjs
 *
 *   # 本番反映
 *   DRY_RUN=false node scripts/init-settlement-automation.mjs
 *
 *   # 既存を強制上書き（通常は使わない）
 *   DRY_RUN=false FORCE_OVERWRITE=true node scripts/init-settlement-automation.mjs
 *
 * 安全策:
 *   1. 既存ドキュメントがある場合はデフォルトで上書きしない（FORCE_OVERWRITE=true で明示承認）
 *   2. dry-run をデフォルトにして誤実行を防ぐ
 *   3. 書き込み内容を事前に表示して確認を促す
 *
 * 実行後の状態:
 *   settings/settlement_automation = {
 *     enabled: false,
 *     disabledReason: 'initial safe default',
 *     disabledBy: 'init-script',
 *     updatedAt: <serverTimestamp>,
 *     updatedBy: 'init-script',
 *     reason: 'initial safe default',
 *     initializedAt: <serverTimestamp>,
 *     initializedBy: 'init-script',
 *     scriptVersion: '2026-04-20.phase2-1.v1',
 *   }
 *
 *   この後、以下の順序で段階1 運用を開始する:
 *     1. Cloud Functions デプロイ（firebase deploy --only functions）
 *     2. Firestore rules デプロイ（firebase deploy --only firestore:rules）
 *     3. 動作確認（dryRun: true での createMonthlySettlement 呼び出し）
 *     4. 社長判断で settings/settlement_automation.enabled = true に切り替え
 *     5. 本番運用開始（2ヶ月観測）
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
const FORCE_OVERWRITE = process.env.FORCE_OVERWRITE === 'true'
const DOC_PATH = 'settings/settlement_automation'
const SCRIPT_VERSION = '2026-04-20.phase2-1.v1'

const INITIAL_PAYLOAD = {
  enabled: false,
  disabledReason: 'initial safe default',
  disabledBy: 'init-script',
  updatedBy: 'init-script',
  reason: 'initial safe default',
  initializedBy: 'init-script',
  scriptVersion: SCRIPT_VERSION,
  // serverTimestamp は呼び出し時に FieldValue.serverTimestamp() を挿入
}

async function main() {
  const projectId = serviceAccount.project_id
  console.log('')
  console.log('======================================')
  console.log('  Phase 2 段階1 初期化スクリプト')
  console.log('======================================')
  console.log(`プロジェクト: ${projectId}`)
  console.log(`対象ドキュメント: ${DOC_PATH}`)
  console.log(`モード: ${DRY_RUN ? '🧪 DRY RUN（書き込みしない）' : '⚠️  本番反映'}`)
  console.log(`強制上書き: ${FORCE_OVERWRITE ? 'YES' : 'NO'}`)
  console.log('')

  // 既存確認
  const ref = db.doc(DOC_PATH)
  const existing = await ref.get()

  if (existing.exists) {
    console.log('📄 既存ドキュメントが存在します:')
    console.log(JSON.stringify(existing.data(), null, 2))
    console.log('')

    if (!FORCE_OVERWRITE) {
      console.log('ℹ️  既存があるためデフォルトではスキップします。')
      console.log('   強制上書きする場合は FORCE_OVERWRITE=true を付けて再実行してください。')
      console.log('')
      if (DRY_RUN) {
        console.log('✅ [DRY RUN] 既存保持でスキップ予定。')
      } else {
        console.log('✅ 既存を保持してスキップしました。')
      }
      process.exit(0)
    }
    console.log('⚠️  FORCE_OVERWRITE=true のため上書きします。')
    console.log('')
  }

  // 書き込み内容の表示
  console.log('📝 書き込み予定の内容:')
  console.log(JSON.stringify(
    {
      ...INITIAL_PAYLOAD,
      updatedAt: '<serverTimestamp>',
      initializedAt: '<serverTimestamp>',
    },
    null,
    2,
  ))
  console.log('')

  if (DRY_RUN) {
    console.log('✅ [DRY RUN] 書き込みはスキップしました。')
    console.log('   本番反映する場合は DRY_RUN=false を付けて再実行してください。')
    process.exit(0)
  }

  // 本番書き込み
  const payload = {
    ...INITIAL_PAYLOAD,
    updatedAt: FieldValue.serverTimestamp(),
    initializedAt: FieldValue.serverTimestamp(),
  }

  try {
    // set(merge: true) で既存 FORCE_OVERWRITE 時も安全側にマージ
    // ただし FORCE_OVERWRITE 時でも enabled は false に確定させる
    await ref.set(payload, { merge: true })
    console.log('✅ 書き込み完了。')
    console.log('')
    console.log('次のステップ:')
    console.log('  1. firebase deploy --only functions  (Cloud Functions デプロイ)')
    console.log('  2. firebase deploy --only firestore:rules  (Firestore rules デプロイ)')
    console.log('  3. createMonthlySettlement を dryRun: true で呼び出して動作確認')
    console.log('  4. 社長判断で settings/settlement_automation.enabled = true に変更')
    console.log('')
  } catch (err) {
    console.error('❌ 書き込み失敗:', err && err.message ? err.message : err)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
