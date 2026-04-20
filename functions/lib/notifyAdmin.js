/**
 * notifyAdmin.js
 *
 * admin 通知の最小実装（Phase 2 段階1 版）。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §3.7
 *
 * 段階1 のスコープ:
 *   - adminNotifications コレクションへの書き込みのみ
 *   - Cloud Logging への console.log も併用（Firestore 障害時の保険）
 *   - メール / SMS / Slack の fan-out は段階2 以降で追加
 *
 * severity 階層:
 *   - 'info'     : 参考情報。admin UI 閲覧可能。通知手段なし（メール送らない）
 *   - 'warning'  : 要注意。24 時間以内の確認推奨（段階2 以降でメール送信）
 *   - 'critical' : 緊急。即時対応必須（段階2 以降で即時メール + SMS）
 *
 * 冪等キー（dedupeKey）:
 *   同じ事象に対する重複通知を抑えるため、関数側で dedupeKey を指定できる。
 *   24 時間以内に同一 dedupeKey が存在する場合はスキップする。
 *   旧通知の上書きはしない（append-only を維持）。
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { Timestamp } = require('firebase-admin/firestore')

const ALLOWED_SEVERITIES = Object.freeze(['info', 'warning', 'critical'])

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 時間
const TITLE_MAX_LEN = 100
const BODY_MAX_LEN = 10000

/**
 * admin への通知を発行する。
 *
 * 段階1 では adminNotifications への書き込みのみ行う。
 * fan-out（メール・SMS）は段階2 以降で deliveryStatus を利用して追加する。
 *
 * @param {object} params
 * @param {'info'|'warning'|'critical'} params.severity
 * @param {string} params.title             - 100 文字以内
 * @param {string} params.body              - 10000 文字以内
 * @param {object} [params.context]         - 関連する kickbackId / runLogId 等
 * @param {string} [params.source]          - 発火元関数名（例: 'stage3_failure_detector'）
 * @param {string} [params.dedupeKey]       - 24 時間以内の重複通知を抑える冪等キー
 * @returns {Promise<{notificationId: string|null, skipped: boolean, reason?: string}>}
 */
async function notifyAdmin({ severity, title, body, context = {}, source = 'unknown', dedupeKey = null } = {}) {
  // --- 入力検証 ---
  if (!ALLOWED_SEVERITIES.includes(severity)) {
    throw new Error(
      `notifyAdmin: invalid severity=${JSON.stringify(severity)}. ` +
      `Must be one of [${ALLOWED_SEVERITIES.join(', ')}]`,
    )
  }
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error('notifyAdmin: title is required (non-empty string)')
  }
  if (typeof body !== 'string') {
    throw new Error('notifyAdmin: body must be a string')
  }

  // --- 切り詰め ---
  const truncatedTitle = title.slice(0, TITLE_MAX_LEN)
  const truncatedBody = body.slice(0, BODY_MAX_LEN)

  const db = getFirestore()
  const col = db.collection('adminNotifications')

  // --- 冪等キーによる重複抑止 ---
  if (dedupeKey) {
    const windowStart = Timestamp.fromMillis(Date.now() - DEDUPE_WINDOW_MS)
    const dupSnap = await col
      .where('dedupeKey', '==', dedupeKey)
      .where('createdAt', '>=', windowStart)
      .limit(1)
      .get()
    if (!dupSnap.empty) {
      // 既存通知があるのでスキップ。Cloud Logging には残す
      // eslint-disable-next-line no-console
      console.log(`[notifyAdmin] skipped by dedupeKey=${dedupeKey} (existing=${dupSnap.docs[0].id})`)
      return { notificationId: null, skipped: true, reason: 'dedupe' }
    }
  }

  // --- Firestore 書き込み ---
  let notificationId = null
  try {
    const ref = await col.add({
      severity,
      title: truncatedTitle,
      body: truncatedBody,
      context: context || {},
      source: String(source || 'unknown').slice(0, 100),
      dedupeKey: dedupeKey || null,
      createdAt: FieldValue.serverTimestamp(),
      deliveryStatus: {
        firestore: { status: 'success', at: FieldValue.serverTimestamp() },
        // email / sms は段階2 以降で追加。現状は not_configured
        email: { status: 'not_configured' },
        sms: { status: 'not_configured' },
      },
      readBy: [],
      acknowledgedAt: null,
      acknowledgedBy: null,
    })
    notificationId = ref.id
  } catch (err) {
    // Firestore 書き込み失敗は Cloud Logging に残して諦める
    // （ここでさらに notifyAdmin を呼ぶと無限ループになるため）
    // eslint-disable-next-line no-console
    console.error('[notifyAdmin] firestore write failed', {
      severity, title: truncatedTitle, error: err && err.message ? err.message : String(err),
    })
    return { notificationId: null, skipped: false, reason: 'firestore_write_failed' }
  }

  // --- Cloud Logging への保険出力 ---
  // 検索性のため JSON 形式で構造化ログを残す
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    tag: 'adminNotification',
    severity,
    title: truncatedTitle,
    source,
    notificationId,
    dedupeKey,
    context,
  }))

  return { notificationId, skipped: false }
}

module.exports = {
  notifyAdmin,
  ALLOWED_SEVERITIES,
}
