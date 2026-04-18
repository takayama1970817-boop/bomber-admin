/**
 * dealerCode リゾルバ（共通ヘルパー）
 *
 * 目的:
 *   orders を create するすべての経路で dealerCode を統一的に引けるようにする。
 *   旧来は BcartImport.jsx 内のローカル関数として実装されていたが、
 *   2026-04-18 の orders.read strict 化に伴い複数経路から再利用するため切り出した。
 *
 * 使い分け:
 *   - Bカート受注データがある経路（BcartImport, bcart-sync 等）
 *       → resolveDealerCodeFromBcartOrder(order) で customer_parent_id 等を抽出
 *   - Bカート連携でない経路（ErpOrders, QuotationManage, OrderForm 等）
 *       → resolveDealerCodeByCompanyName(db, companyName) で Firestore を引く
 *       → 見つからない場合は null を返す（呼び出し側は記録して進む）
 */
import { collection, getDocs, query, where, limit } from 'firebase/firestore'

/**
 * Bカート受注オブジェクトから dealerCode を抽出。
 * Bカート側のフィールドは customer_parent_id が主ソースだが、
 * 配信バージョンによって parent_id / parent_member_id が使われるケースもある。
 *
 * @param {Object} order - Bカート受注オブジェクト
 * @returns {string} 整形済み dealerCode（見つからなければ空文字）
 */
export function resolveDealerCodeFromBcartOrder(order) {
  const raw = order?.customer_parent_id ?? order?.parent_id ?? order?.parent_member_id ?? ''
  return String(raw).trim()
}

/**
 * companyName から dealerCode を Firestore で検索する。
 *
 * 検索順序（最初に見つかったものを採用）:
 *   1. salons コレクション（公式サロンマスタ）
 *   2. allowedEmails（招待時に dealerCode が付与されている可能性）
 *
 * 複数ヒットしたら最初の1件を返す（サロンは通常 companyName 一意想定）。
 * 見つからない場合は null を返し、呼び出し側で「解決不能」として扱う。
 *
 * @param {import('firebase/firestore').Firestore} db - Firestore インスタンス
 * @param {string} companyName - サロン会社名
 * @returns {Promise<string | null>} dealerCode または null
 */
export async function resolveDealerCodeByCompanyName(db, companyName) {
  const name = (companyName || '').trim()
  if (!name) return null

  // 1. salons コレクション
  try {
    const snap = await getDocs(
      query(
        collection(db, 'salons'),
        where('companyName', '==', name),
        limit(1),
      ),
    )
    if (!snap.empty) {
      const code = (snap.docs[0].data().dealerCode || '').trim()
      if (code) return code
    }
  } catch (e) {
    // インデックス未作成等は握りつぶして次の経路へ
    console.warn('[dealerCodeResolver] salons 検索失敗:', e.message)
  }

  // 2. allowedEmails（招待時 dealerCode が設定されているケース）
  try {
    const snap = await getDocs(
      query(
        collection(db, 'allowedEmails'),
        where('companyName', '==', name),
        where('role', '==', 'salon'),
        limit(1),
      ),
    )
    if (!snap.empty) {
      const code = (snap.docs[0].data().dealerCode || '').trim()
      if (code) return code
    }
  } catch (e) {
    console.warn('[dealerCodeResolver] allowedEmails 検索失敗:', e.message)
  }

  return null
}
