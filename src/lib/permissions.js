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
 * canEditVisit                |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canDeleteVisit              |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canManageSalonProduct       |   ✅   |  ✅   |   ✅  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canSyncBcartProducts        |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canBulkDeleteSalonProducts  |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canEditSettings             |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canExportSettlement         |   ✅   |  ✅   |   ✅  |    ❌     |    ✅     |    ✅     |    ❌    |   ❌
 * canManageDocuments          |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ❌    |   ❌
 * canEditSalonAccount         |   ✅   |  ✅   |   ❌  |    ❌     |    ❌     |    ❌     |    ✅    |   ❌
 * canEditDealerAccount        |   ✅   |  ✅   |   ❌  |    ❌     |    ✅     |    ❌     |    ❌    |   ❌
 * canSendMessage (チャット送信)|   ✅   |  ✅   |   ✅  |    ✅     |    ✅     |    ✅     |    ✅    |   ✅
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
 *   2026-04-16 以降、dealer/salon の subRole 未設定は拒否対象（rules で弾く）
 */

// ====== 基本判定 ======
export function isMaster(p) { return p?.role === 'master' }
export function isAdmin(p) { return p?.role === 'admin' || p?.role === 'master' }
export function isStaff(p) { return p?.role === 'staff' }
export function isWarehouse(p) { return p?.role === 'warehouse' }
export function isDealer(p) { return p?.role === 'dealer' }
export function isSalon(p) { return p?.role === 'salon' }

// dealer / salon のサブロール
// 2026-04-16 の一括付与完了後は subRole 必ず入っている想定
// 互換保護のため subRole 未設定時は admin 扱い（UI 層のみ、rules では拒否）
export function isDealerAdmin(p) {
  return isDealer(p) && (p?.subRole === 'admin' || !p?.subRole)
}
export function isDealerStaff(p) {
  return isDealer(p) && p?.subRole === 'staff'
}
export function isSalonAdmin(p) {
  return isSalon(p) && (p?.subRole === 'admin' || !p?.subRole)
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

/** 来店履歴の編集（破壊系なので salonStaff は NG。将来 createdBy で自分作成分のみ可に拡張予定） */
export function canEditVisit(p) {
  if (isSalonStaff(p)) return false
  return isSalonAdmin(p) || isAdmin(p)
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

/** チャット送信（業務連絡なので全員可） */
export function canSendMessage(p) {
  // ログイン済みなら誰でも送信可能（業務連絡の円滑化）
  return !!p?.role
}

/** チャット部屋管理（作成・削除・メンバー変更、admin のみ） */
export function canManageChatRoom(p) { return isAdmin(p) }

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
