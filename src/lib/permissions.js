/**
 * =======================================================================
 * ⚠️ 権限判定の単一責任ファイル
 * =======================================================================
 * 全ての権限判定はこのファイルに集約する。
 * AuthContext / 画面 / Firestore rules との整合はここで担保する。
 *
 * - 画面側は直接 import { canXxx } from '../lib/permissions.js'
 * - AuthContext はラッパー（永続化）として isAdmin 等を露出するのみ
 * - 二重実装禁止。判定ロジックを他ファイルに書かない。
 * =======================================================================
 *
 * 権限マトリクス（操作単位）
 *
 * ============================================================================
 * 権限マトリクス（役割 × 操作）
 * ============================================================================
 *                             | master | admin | staff | warehouse | dealerAdm | dealerStf | salonAdm | salonStf
 * canInvite                   |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canCreateCustomer           |   ✅   |  ✅   |   ✅  |    ❌     |    ❌     |    ❌     |    ✅    |   ✅
 * canEditCustomer             |   ✅   |  ✅   |   ✅  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canDeleteCustomer           |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canImportCsv                |   ✅   |  ✅   |   ✅  |    ❌     |    ✅     |    ❌     |    ✅    |   ❌
 * canAddVisit                 |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ✅
 * canEditVisit                |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   △(*1)
 * canDeleteVisit              |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 *
 * (*1) salonStaff の canEditVisit は visit.createdBy === 自分のuid のときのみ true。
 *      visit 引数なし or createdBy が欠けた旧データは不可（保守的扱い）。
 * canManageSalonProduct       |   ✅   |  ✅   |   ✅  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canSyncBcartProducts        |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canBulkDeleteSalonProducts  |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canEditSettings             |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canExportSettlement         |   ✅   |  ✅   |   ✅  |    ❌     |    ✅     |    ✅     |    ❌    |   ❌
 * canManageDocuments          |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canEditSalonAccount         |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canEditDealerAccount        |   ✅   |  ✅   |   ❌  |    ❌     |    ✅     |    ❌     |    ❌    |   ❌
 * canManageDealerSalons       |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canManageKickback           |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canManageInvoice            |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canSendMessage (チャット送信)|   ✅   |  ✅   |   ✅  |    ✅     |    ✅     |    ✅     |    ✅    |   ✅
 * canDeleteOwnChatMessage     |   ✅   |  ✅   |   ✅  |    ✅     |    ✅     |    ✅     |    ✅    |   ✅
 * canManageChatRoom (部屋管理) |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * ============================================================================
 *
 * 設計方針:
 *   - UI 非表示・保存処理 assertCan・Firestore rules の三重防御
 *   - 権限ロジックはこのファイル 1 箇所に集約（画面単位でなく操作単位）
 *   - 判定関数は profile を引数に取り boolean を返す純粋関数
 *   - AuthContext は permissions.js を import して再エクスポート（単一責任）
 *
 * role / subRole:
 *   role: 'master' | 'admin' | 'staff' | 'dealer' | 'salon' | 'warehouse'
 *   subRole: 'admin' | 'staff'（dealer / salon のみ使用）
 *   2026-04-17 カットオーバー完了: subRole 未設定は UI / rules の両方で拒否（strict）
 *   以降 dealer/salon アカウントは招待時に必ず subRole をセットすること。
 */

// ====== 基本判定 ======
export function isMaster(p) { return p?.role === 'master' }
export function isAdmin(p) { return p?.role === 'admin' || p?.role === 'master' }
export function isStaff(p) { return p?.role === 'staff' }
export function isWarehouse(p) { return p?.role === 'warehouse' }
export function isDealer(p) { return p?.role === 'dealer' }
export function isSalon(p) { return p?.role === 'salon' }

// dealer / salon のサブロール（strict モード）
// 2026-04-16 に subRole 一括付与スクリプト（scripts/backfill-subrole.mjs）を実行し、
// 2026-04-17 の dry-run で「未設定 0件」を確認。監査ログ: subRoleBackfillLogs/NiaoxkIBMvQrZFE3hBc8
// → lax フォールバック（未設定=admin扱い）を撤去。rules の hasValidSubRole() と完全一致させる。
// 以降 subRole が未設定のユーザーは UI 上も「権限なし」として振る舞う（設計ミス検知）。
export function isDealerAdmin(p) {
  return isDealer(p) && p?.subRole === 'admin'
}
export function isDealerStaff(p) {
  return isDealer(p) && p?.subRole === 'staff'
}
export function isSalonAdmin(p) {
  return isSalon(p) && p?.subRole === 'admin'
}
export function isSalonStaff(p) {
  return isSalon(p) && p?.subRole === 'staff'
}

// ====== 操作単位の権限関数 ======

/** 招待（代理店・サロン招待、RT のみ） */
export function canInvite(p) { return isAdmin(p) }

/** サロンの顧客新規登録（現場は動けるが壊せない方針：salonStaff も OK） */
export function canCreateCustomer(p) {
  return isSalon(p) || isAdmin(p) || isStaff(p)
}

/** サロンの顧客編集（salonStaff は NG） */
export function canEditCustomer(p) {
  if (isSalonStaff(p)) return false
  return isSalon(p) || isAdmin(p) || isStaff(p)
}

/** サロンの顧客削除（より厳しい） */
export function canDeleteCustomer(p) {
  if (isSalonStaff(p)) return false
  return isSalonAdmin(p) || isAdmin(p)
}

/** CSV 取込（顧客一括・Bカートなど） */
export function canImportCsv(p) {
  if (isSalonStaff(p) || isDealerStaff(p)) return false
  return isSalonAdmin(p) || isDealerAdmin(p) || isAdmin(p) || isStaff(p)
}

/** 来店履歴の追加（現場運用優先：salonStaff も OK） */
export function canAddVisit(p) {
  return isSalonAdmin(p) || isSalonStaff(p) || isAdmin(p)
}

/**
 * 来店履歴の編集。
 *
 * 権限マトリクス:
 *   - admin / salonAdmin: visit の内容に関わらず常に true
 *   - salonStaff:         visit.createdBy === profile.uid のときのみ true
 *   - それ以外の role:     常に false
 *
 * 仕様上の重要な注意点:
 *   1. salonStaff に対して visit 引数を省略した場合は false を返す。
 *      UI で行単位に visit を渡し忘れた場合、誤って「編集可」と判定しないため。
 *   2. visit.createdBy が欠損している旧データは salonStaff からは編集不可。
 *      createdBy がいつからセットされ始めたか追跡できないので、
 *      保守的に「旧データは salonAdmin 以上に任せる」ポリシーとした。
 *   3. profile.uid が欠けている（認証セッション壊れている）場合も false。
 *      rules 側で createdBy == request.auth.uid を要求しているため、
 *      UI で通しても rules で弾かれて一貫する。
 *
 * 三重防御:
 *   UI 表示（行単位で本関数を呼ぶ）
 *   + 保存前 assertCan（VisitForm 内）
 *   + firestore.rules（visits.update に同等条件）
 *
 * @param {Object} profile - AuthContext の profile（role, subRole, uid を含む）
 * @param {Object} [visit] - 編集対象の visit ドキュメントデータ（createdBy を含む）
 * @returns {boolean}
 */
export function canEditVisit(profile, visit) {
  if (isAdmin(profile) || isSalonAdmin(profile)) return true
  if (isSalonStaff(profile)) {
    const uid = profile?.uid
    const createdBy = visit?.createdBy
    // visit 指定なし or createdBy が無い旧データは NG（旧データは salonAdmin に任せる）
    if (!visit || !createdBy || !uid) return false
    return createdBy === uid
  }
  return false
}

/** 来店履歴の削除（破壊系なので salonStaff は NG） */
export function canDeleteVisit(p) {
  if (isSalonStaff(p)) return false
  return isSalonAdmin(p) || isAdmin(p)
}

/** 店販商品マスタの CRUD（本社 RT admin/staff のみ） */
export function canManageSalonProduct(p) {
  return isAdmin(p) || isStaff(p)
}

/** Bカートからの商品同期（API / CSV）— データ破壊リスクが高いため admin のみ */
export function canSyncBcartProducts(p) {
  return isAdmin(p)
}

/** 店販商品マスタの一括削除（admin のみ） */
export function canBulkDeleteSalonProducts(p) {
  return isAdmin(p)
}

/** 設定変更（ブランド・権限・キックバック設定など、RT のみ） */
export function canEditSettings(p) { return isAdmin(p) }

/** キックバック清算書の出力（PDF/CSV） */
export function canExportSettlement(p) {
  if (isDealerAdmin(p) || isDealerStaff(p)) return true
  return isAdmin(p) || isStaff(p)
}

/** 代理店・サロン資料の管理（RT のみ） */
export function canManageDocuments(p) { return isAdmin(p) }

/** サロンアカウント情報の編集 */
export function canEditSalonAccount(p) {
  if (isSalonStaff(p)) return false
  return isSalonAdmin(p) || isAdmin(p)
}

/** 代理店アカウント情報の編集 */
export function canEditDealerAccount(p) {
  if (isDealerStaff(p)) return false
  return isDealerAdmin(p) || isAdmin(p)
}

/** 代理店↔サロン紐付けの管理（本社 admin のみ。RT の設定作業） */
export function canManageDealerSalons(p) { return isAdmin(p) }

/** キックバック清算書の管理（作成・編集・削除）。dealer 側は閲覧のみ */
export function canManageKickback(p) { return isAdmin(p) }

/** 代理店請求書の管理（作成・編集・削除）。dealer 側は自社分の閲覧のみ */
export function canManageInvoice(p) { return isAdmin(p) }

/** チャット送信（業務連絡なので全員可） */
export function canSendMessage(p) {
  // ログイン済みなら誰でも送信可能（業務連絡の円滑化）
  return !!p?.role
}

/**
 * 自分が投稿したチャットメッセージの削除。
 *
 * - 送信と同じくログイン済みユーザーなら自分の発言を消せる
 * - 他人の発言は canManageChatRoom（admin）のみ触れる
 * - 呼び出し側で `message.uid === profile.uid` の前提で使う
 *   （rules 側でも `resource.data.uid == request.auth.uid` でガード済み）
 */
export function canDeleteOwnChatMessage(p) {
  return !!p?.role
}

/** チャット部屋管理（作成・削除・メンバー変更、admin のみ） */
export function canManageChatRoom(p) { return isAdmin(p) }

// ====== ERP 関連権限（Phase 1 実装） ======================
// 設計書: docs/04_ERP_DATA_MODEL.md §6
// Phase 1 の ERP 画面は admin と internal(=既存 staff) のみ有効。
// factory / supplier / warehouse / dealer / salon は erp_ collection アクセス禁止。

/** internal = 既存 staff の ERP 文脈での呼称（エイリアス） */
export function isInternal(p) { return p?.role === 'staff' }

/** ERP 画面にアクセスできる人（admin/master/internal=staff） */
export function isErpUser(p) { return isAdmin(p) || isInternal(p) }

// --- 受注 ---
export function canCreateOrder(p) { return isErpUser(p) }
export function canEditOrder(p) { return isErpUser(p) }
export function canApproveOrder(p) { return isAdmin(p) }
export function canCancelOrder(p) { return isAdmin(p) }

// --- 発注 ---
export function canCreatePurchaseOrder(p) { return isErpUser(p) }
export function canEditPurchaseOrder(p) { return isErpUser(p) }
export function canApprovePurchaseOrder(p) { return isAdmin(p) }
export function canSendPurchaseOrder(p) { return isErpUser(p) }
/** 発注取消は破壊的なので admin のみ */
export function canCancelPurchaseOrder(p) { return isAdmin(p) }

// --- 在庫 ---
export function canViewInventory(p) { return isErpUser(p) }
export function canAdjustInventory(p) { return isAdmin(p) }

// --- 入庫 ---
export function canInputStockIn(p) { return isErpUser(p) }
export function canApproveStockIn(p) { return isAdmin(p) }

// --- 出荷 ---
export function canCreateShipment(p) { return isErpUser(p) }
export function canInputShipment(p) { return isErpUser(p) }
export function canApproveShipment(p) { return isAdmin(p) || isInternal(p) }
export function canCancelShipment(p) { return isAdmin(p) }

// --- 監査ログ閲覧（admin のみ）---
export function canViewAuditLog(p) { return isAdmin(p) }

// --- Phase 1 では未使用（設計のみ、誤配線防止の TODO 付き）---
/** TODO(Phase 2+): ProductionResult 入力（factory role 実装後に有効化） */
export function canInputProductionResult(p) { return isAdmin(p) }
/** TODO(Phase 2+): Production 承認 */
export function canApproveProduction(p) { return isAdmin(p) }
/** TODO(Phase 2+): 請求書作成 */
export function canCreateInvoice(p) { return isAdmin(p) }
/** TODO(Phase 2+): 請求書承認 */
export function canApproveInvoice(p) { return isAdmin(p) }
/** TODO(Phase 2+): 入金記録 */
export function canRecordPayment(p) { return isAdmin(p) }

// ====== assertCan（保存処理側のガード） ======
/**
 * 実行前に呼び、false なら throw する。
 * UI 非表示だけでは迂回されるため、Firestore 書き込み直前に必ず実行。
 *
 * ログレベル分離:
 *   - 通常の拒否（既知の挙動）: console.warn
 *   - 重大違反（profile 欠損等の異常）: console.error
 *
 * @param {Function} fn - 権限判定関数（canXxx）
 * @param {Object} profile - AuthContext の profile
 * @param {Object} [options]
 * @param {string} [options.userMessage] - ユーザー向けメッセージ（UI表示用）
 * @param {string} [options.logMessage] - ログ向けメッセージ（console用）
 * @param {'warn'|'error'} [options.logLevel] - ログレベル（既定: warn）
 * @throws {Error} 権限不足時
 */
export function assertCan(fn, profile, options = {}) {
  if (fn(profile)) return
  const opName = fn.name || 'operation'
  const userMsg = options.userMessage || 'この操作を行う権限がありません'
  const logMsg = options.logMessage
    || `[assertCan] Denied: ${opName} for role=${profile?.role} subRole=${profile?.subRole} uid=${profile?.uid || '(anon)'}`

  // profile 不在は通常ありえない → error レベル
  // 権限が足りないだけなら warn レベル
  const isAbnormal = !profile || !profile.role
  const level = options.logLevel || (isAbnormal ? 'error' : 'warn')
  if (level === 'error') console.error(logMsg)
  else console.warn(logMsg)

  const err = new Error(userMsg)
  err.code = 'permission-denied'
  err.operation = opName
  throw err
}
