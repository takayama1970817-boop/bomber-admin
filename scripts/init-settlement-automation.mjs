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
 *   # 運用中 (enabled=true) を強制停止する場合 (v1.1 追加)
 *   # FORCE_OVERWRITE だけでは enabled=true → false の誤落としを防ぐため、
 *   # 以下を追加承認として指定する必要がある
 *   DRY_RUN=false FORCE_OVERWRITE=true ACKNOWLEDGE_ENABLED_OVERRIDE=true \
 *     node scripts/init-settlement-automation.mjs
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
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

/**
 * 認証情報の優先順位（v1.2 追加 / CI 対応）:
 *   1. GOOGLE_APPLICATION_CREDENTIALS 環境変数（CI・ADC）
 *   2. scripts/service-account.json（ローカル実行）
 *
 * GitHub Actions で google-github-actions/auth@v2 を使った場合は
 * GOOGLE_APPLICATION_CREDENTIALS が自動設定されるため、
 * scripts/service-account.json がなくても動く。
 */
let serviceAccount = null
if (getApps().length === 0) {
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (adcPath && existsSync(adcPath)) {
    // CI / ADC 経路
    initializeApp({ credential: applicationDefault() })
    try {
      serviceAccount = JSON.parse(readFileSync(adcPath, 'utf8'))
    } catch (_e) {
      // project_id 読み取り用の補助。失敗しても続行可
      serviceAccount = { project_id: '(unknown)' }
    }
  } else {
    // ローカル実行経路
    const LOCAL_SA_PATH = new URL('./service-account.json', import.meta.url)
    if (!existsSync(LOCAL_SA_PATH)) {
      console.error('❌ 認証情報が見つかりません。')
      console.error('   以下のいずれかを満たしてください:')
      console.error('   1. GOOGLE_APPLICATION_CREDENTIALS 環境変数を設定（CI）')
      console.error('   2. scripts/service-account.json を配置（ローカル）')
      process.exit(1)
    }
    serviceAccount = JSON.parse(readFileSync(LOCAL_SA_PATH, 'utf8'))
    initializeApp({ credential: cert(serviceAccount) })
  }
}
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const FORCE_OVERWRITE = process.env.FORCE_OVERWRITE === 'true'
// v1.1 追加: 運用中 (enabled=true) を強制初期化する時の追加承認フラグ
//   FORCE_OVERWRITE=true だけでは enabled=true → false の誤落としを許さない。
//   運用中を強制初期化するには ACKNOWLEDGE_ENABLED_OVERRIDE=true も必須。
const ACKNOWLEDGE_ENABLED_OVERRIDE = process.env.ACKNOWLEDGE_ENABLED_OVERRIDE === 'true'

const DOC_PATH = 'settings/settlement_automation'
const SCRIPT_VERSION = '2026-04-20.phase2-1.v1.2'

const INITIAL_PAYLOAD = {
  enabled: false,
  // 軽微1 (v1.1): disabledAt を追加して §1.9 スキーマに一致させる
  // disabledAt は呼び出し時に FieldValue.serverTimestamp() を挿入
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
    const existingData = existing.data() || {}
    const existingEnabled = existingData.enabled === true

    console.log('📄 既存ドキュメントが存在します:')
    console.log(JSON.stringify(existingData, null, 2))
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

    // 重大1 (v1.1): FORCE_OVERWRITE=true でも運用中 (enabled=true) を
    //               無条件に false へ上書きさせない二段階承認
    if (existingEnabled && !ACKNOWLEDGE_ENABLED_OVERRIDE) {
      console.error('❌ 既存の enabled=true を FORCE_OVERWRITE で false に上書きしようとしています。')
      console.error('')
      console.error('   これは運用中の自動化を強制停止する操作になります。')
      console.error('   本当に停止する意図があるなら、以下の環境変数も併用してください:')
      console.error('')
      console.error('     ACKNOWLEDGE_ENABLED_OVERRIDE=true')
      console.error('')
      console.error('   未設定の場合は安全のため中断します。')
      process.exit(2)
    }
    if (existingEnabled && ACKNOWLEDGE_ENABLED_OVERRIDE) {
      console.log('⚠️  FORCE_OVERWRITE=true + ACKNOWLEDGE_ENABLED_OVERRIDE=true')
      console.log('    運用中 (enabled=true) を強制停止 (enabled=false) に落とします。')
      console.log('')
    } else {
      console.log('⚠️  FORCE_OVERWRITE=true のため上書きします。')
      console.log('')
    }
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

  // 本番書き込み（軽微1: disabledAt を追加 / §1.9 スキーマ一致）
  const payload = {
    ...INITIAL_PAYLOAD,
    disabledAt: FieldValue.serverTimestamp(),
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
