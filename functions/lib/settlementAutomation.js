/**
 * settlementAutomation.js
 *
 * settings/settlement_automation ドキュメントの読取・即停止操作。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §1.9
 *
 * ポリシー:
 *   - enabled === true のときだけ自動処理を走らせる
 *   - enabled は各代理店ループ冒頭で毎回再確認する（§1.6 break 離脱構造）
 *   - 停止操作（enabled=false 化）は Cloud Functions Admin SDK のみから行う
 *   - 設定ドキュメントが存在しない場合は安全側で「無効」とみなす
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore')

const SETTINGS_PATH = 'settings/settlement_automation'

/**
 * settings/settlement_automation を取得する。
 * ドキュメントが存在しない場合は enabled=false と同等の空オブジェクトを返す。
 *
 * @param {FirebaseFirestore.Firestore} [db]
 * @returns {Promise<object>}
 */
async function getAutomationConfig(db) {
  const firestore = db || getFirestore()
  const snap = await firestore.doc(SETTINGS_PATH).get()
  if (!snap.exists) {
    return { enabled: false, _missing: true }
  }
  return snap.data() || {}
}

/**
 * enabled が true でなければ throw する。バッチ開始時の最初のチェックに使う。
 *
 * @param {FirebaseFirestore.Firestore} [db]
 * @throws {Error} enabled !== true の場合
 */
async function assertAutomationEnabled(db) {
  const config = await getAutomationConfig(db)
  if (config.enabled !== true) {
    const err = new Error(
      `settlement_automation is disabled` +
      (config._missing ? ' (settings/settlement_automation not found)' : ''),
    )
    err.code = 'automation_disabled'
    err.config = config
    throw err
  }
  return config
}

/**
 * enabled が true かどうかを返す（throw しない版）。
 * 各代理店ループの冒頭で break 離脱判定に使う。
 *
 * @param {FirebaseFirestore.Firestore} [db]
 * @returns {Promise<boolean>}
 */
async function isAutomationEnabled(db) {
  try {
    const config = await getAutomationConfig(db)
    return config.enabled === true
  } catch (_e) {
    return false
  }
}

/**
 * automation を即時停止する。
 * 検知関数（detectDuplicates 等）から異常検知時に呼ばれる。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} params
 * @param {string} params.disabledBy      - 停止実行者（関数名 or uid）
 * @param {string} params.disabledReason  - 停止理由
 */
async function disableAutomation(db, { disabledBy, disabledReason }) {
  const firestore = db || getFirestore()
  await firestore.doc(SETTINGS_PATH).set(
    {
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledBy: String(disabledBy || 'unknown').slice(0, 200),
      disabledReason: String(disabledReason || '').slice(0, 1000),
    },
    { merge: true },
  )
}

module.exports = {
  SETTINGS_PATH,
  getAutomationConfig,
  assertAutomationEnabled,
  isAutomationEnabled,
  disableAutomation,
}
