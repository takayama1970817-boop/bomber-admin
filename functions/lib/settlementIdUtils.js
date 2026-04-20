/**
 * settlementIdUtils.js
 *
 * Phase 2 段階1 重複作成防止機構の基礎ユーティリティ。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §1.2
 *
 * 提供:
 *   - ALLOWED_TYPES   : 精算種別の enum 定数
 *   - SKIP_REASONS    : スキップ理由コードの allowlist（作成側 + 送信側 共通）
 *   - validateType / validateDealerCode / validateMonth
 *   - buildSettlementDocId({ type, dealerCode, month })
 *     → 構造化 docId "{type}_{dealerCode}_{YYYY-MM}" を生成
 *   - isStructuredSettlementDocId(docId)
 *     → docId が新フォーマット（構造化）かの判定。detectDuplicates の除外判定に使う
 *
 * 重要な設計判断:
 *   1. type は 'kb' / 'invoice' の2値のみ（将来拡張は ALLOWED_TYPES 改訂で対応）
 *   2. dealerCode は J 形式（^J\d{4}$）のみ許可（Phase 1 で 8 代理店を J0016-J0023 に統一済）
 *   3. month は YYYY-MM 形式のみ許可（01〜12 の月のみ）
 *   4. validate* 関数は docId 生成前の早期 throw で不正値を水際阻止する
 *   5. isStructuredSettlementDocId は既存 addDoc 自動採番データとの衝突回避に使う
 *      （detectDuplicates 内で新フォーマットのみを検知対象とする）
 */

// =====================================================================
// 定数
// =====================================================================

/**
 * 精算種別の enum。
 *
 * 将来拡張（現時点では実装不要・設計メモ）:
 *   - 'refund'     : 返金（代理店への返金が発生した月の精算）
 *   - 'adjustment' : 調整（過月分の修正・再計算・手動調整）
 *   - 'payment'    : 支払系（RT から代理店への別建て支払が発生した場合）
 *
 * 追加時の手順:
 *   1. 本 ALLOWED_TYPES を改訂
 *   2. buildSettlementDocId の collection マッピングを更新
 *   3. rules 側の match /{type}/{docId} を追加
 *   4. 社長承認 + 設計書 §13 変更履歴に記録
 */
const ALLOWED_TYPES = Object.freeze(['kb', 'invoice'])

/**
 * スキップ理由コードの allowlist（§1.8 + §2.3 共通体系）。
 *
 * 作成側・送信側で同じコード体系を共有する。新規コードを追加する場合は
 * 本定数と設計書 §1.8 / §2.3 の両方に反映する。
 */
const SKIP_REASONS = Object.freeze([
  // 作成側・送信側 共通
  'no_kbGroup',               // 代理店の kbGroup 未設定
  'dealer_inactive',          // dealers.active === false
  'data_inconsistency',       // Bカートと Firestore の不整合
  'automation_disabled_midrun', // バッチ途中で enabled=false 検知

  // 作成側固有
  'already_exists',           // 既に作成済み（正常スキップ）
  'no_target_orders',         // 対象月に注文 0 件

  // 送信側固有
  'not_approved',             // status が approved / issued でない
  'invalid_email',            // settlementEmail 未設定 or 不正形式
  'document_missing',         // 対象帳票が存在しない
])

const DEALER_CODE_REGEX = /^J\d{4}$/
const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/
const STRUCTURED_DOC_ID_REGEX = /^(kb|invoice)_J\d{4}_\d{4}-(0[1-9]|1[0-2])$/

// =====================================================================
// バリデーション関数
// =====================================================================

/**
 * type が ALLOWED_TYPES のいずれかであることを検証する。
 * 不正値は即座に throw し、Cloud Functions の上位で失敗扱いにする。
 *
 * @param {unknown} type
 * @throws {Error} 不正な type の場合
 */
function validateType(type) {
  if (typeof type !== 'string' || !ALLOWED_TYPES.includes(type)) {
    throw new Error(
      `Invalid type: ${JSON.stringify(type)}. ` +
      `Must be one of [${ALLOWED_TYPES.join(', ')}]`,
    )
  }
}

/**
 * dealerCode が J 形式（J + 4 桁数字）であることを検証する。
 *
 * Phase 1 で 8 代理店（v1-V7, I001）を J 形式（J0016-J0023）に統一済。
 * 新規代理店登録時も J 形式を強制する前提。
 *
 * @param {unknown} code
 * @throws {Error} 不正な dealerCode の場合
 */
function validateDealerCode(code) {
  if (typeof code !== 'string' || !DEALER_CODE_REGEX.test(code)) {
    throw new Error(
      `Invalid dealerCode: ${JSON.stringify(code)}. ` +
      `Must match ${DEALER_CODE_REGEX}`,
    )
  }
}

/**
 * month が YYYY-MM 形式（2026-04 等）であることを検証する。
 *
 * - 月は 01〜12 のみ許可
 * - 年は 4 桁必須（2桁省略記法は不可）
 *
 * @param {unknown} month
 * @throws {Error} 不正な month の場合
 */
function validateMonth(month) {
  if (typeof month !== 'string' || !MONTH_REGEX.test(month)) {
    throw new Error(
      `Invalid month: ${JSON.stringify(month)}. ` +
      `Must match YYYY-MM (e.g. '2026-04')`,
    )
  }
}

// =====================================================================
// docId 生成・判定
// =====================================================================

/**
 * 構造化 docId を生成する。
 * 形式: {type}_{dealerCode}_{YYYY-MM}
 *
 * 生成前に validateType / validateDealerCode / validateMonth を全て通し、
 * 不正値は docId 生成段階で throw する（Firestore 書き込み前に水際阻止）。
 *
 * @param {object} params
 * @param {string} params.type        - 'kb' | 'invoice'
 * @param {string} params.dealerCode  - J 形式（J0015 等）
 * @param {string} params.month       - YYYY-MM 形式
 * @returns {string} 構造化 docId
 * @throws {Error} 入力不正時
 */
function buildSettlementDocId({ type, dealerCode, month }) {
  validateType(type)
  validateDealerCode(dealerCode)
  validateMonth(month)
  return `${type}_${dealerCode}_${month}`
}

/**
 * 与えられた docId が新フォーマット（構造化）かを判定する。
 *
 * detectDuplicates では「既存の addDoc 自動採番データ」と「新フォーマット」が
 * 同一 {dealerCode, month} で混在しうる。段階1 の 2 か月間は既存データを
 * 壊さない運用のため、新フォーマット同士の衝突のみを検知対象とする。
 *
 * 使用例:
 *   for (const doc of snap.docs) {
 *     if (!isStructuredSettlementDocId(doc.id)) continue
 *     // ...
 *   }
 *
 * @param {string} docId
 * @returns {boolean} 構造化 docId なら true
 */
function isStructuredSettlementDocId(docId) {
  return typeof docId === 'string' && STRUCTURED_DOC_ID_REGEX.test(docId)
}

/**
 * type から Firestore コレクション名を取得する。
 *
 * @param {string} type  - 'kb' | 'invoice'
 * @returns {string}     - 'kickbacks' | 'invoices'
 * @throws {Error} 不正な type の場合
 */
function resolveCollectionName(type) {
  validateType(type)
  if (type === 'kb') return 'kickbacks'
  if (type === 'invoice') return 'invoices'
  // validateType を通過した時点で到達不可。安全側に throw。
  throw new Error(`resolveCollectionName: unreachable type=${type}`)
}

/**
 * 前月の YYYY-MM を算出する（Scheduler 実行時のデフォルト対象月）。
 *
 * 例:
 *   2026-05-01 03:00 JST 実行 → '2026-04'
 *
 * @param {Date} [now]  - 基準時刻（省略時は現在）
 * @returns {string}    - YYYY-MM 形式
 */
function previousMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

module.exports = {
  ALLOWED_TYPES,
  SKIP_REASONS,
  DEALER_CODE_REGEX,
  MONTH_REGEX,
  validateType,
  validateDealerCode,
  validateMonth,
  buildSettlementDocId,
  isStructuredSettlementDocId,
  resolveCollectionName,
  previousMonth,
}
