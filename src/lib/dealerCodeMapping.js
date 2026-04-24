/**
 * dealerCode マッピングヘルパー（Bカート ↔ アプリ）
 *
 * ## 背景
 * Bカート側 customer_parent_id（例 'v1', 'v2'）と
 * アプリ側 dealerCode（例 'J0016', 'J0017'）が異なる代理店が存在する。
 *
 *   J0016 ⇄ v1
 *   J0017 ⇄ v2
 *   J0018 ⇄ v3
 *   J0019 ⇄ v4
 *   J0020 ⇄ v5
 *   J0021 ⇄ v6
 *
 * 一方で J0002 / J0003 / J0015 等は Bカート側も同 ID なので変換不要。
 *
 * ## マッピングソース
 * `allowedEmails` コレクションの dealer 行に
 *   { dealerCode: 'J0016', bcartParentId: 'v1' }
 * のようにフィールドペアを持たせる（PR β 以降で seed 予定）。
 *
 * ## このモジュールの位置づけ
 * - 純粋関数のみ（Firestore SDK 依存なし）
 * - frontend / Node スクリプト両方から import 可
 * - 書き込みは行わない
 *
 * ## 解決ルール（resolveDealerCode）
 *   1. マップに登録あり          → アプリ dealerCode を返す（例: v1 → J0016）
 *   2. 未登録かつ /^v\d+$/      → '' + console.warn（fail-closed・誤書込防止）
 *   3. 未登録かつ他パターン      → 入力をそのまま返す（J0002 等の従来一致は無影響）
 *
 * ## 逆方向（resolveBcartParent）
 *   読み取り用途中心のため fail-closed なし。マップなしはフォールバック。
 */

/**
 * allowedEmails レコード配列から双方向マッピングを構築する。
 *
 * @param {Array<{dealerCode?: string, bcartParentId?: string, role?: string}>} allowedEmailsRecords
 * @returns {{ byBcartParent: Map<string,string>, byDealerCode: Map<string,string> }}
 */
export function buildDealerCodeMap(allowedEmailsRecords) {
  const byBcartParent = new Map() // 'v1' → 'J0016'
  const byDealerCode = new Map()  // 'J0016' → 'v1'
  if (!Array.isArray(allowedEmailsRecords)) {
    return { byBcartParent, byDealerCode }
  }
  for (const r of allowedEmailsRecords) {
    if (!r) continue
    if (r.role !== 'dealer') continue
    const dc = String(r.dealerCode || '').trim()
    if (!dc) continue
    const bp = String(r.bcartParentId || '').trim()
    if (bp && bp !== dc) {
      byBcartParent.set(bp, dc)
      byDealerCode.set(dc, bp)
    }
  }
  return { byBcartParent, byDealerCode }
}

/**
 * Bカート customer_parent_id → アプリ dealerCode に解決。
 *
 * - マップにヒットすれば登録された dealerCode を返す
 * - 未登録かつ /^v\d+$/ パターンの ID は誤書込防止のため空文字を返す（warn）
 * - 未登録の他パターン（J0002 等）はそのまま返す（後方互換）
 *
 * @param {string|null|undefined} bcartParentId
 * @param {{ byBcartParent: Map<string,string> }=} map
 * @returns {string}
 */
export function resolveDealerCode(bcartParentId, map) {
  const t = String(bcartParentId || '').trim()
  if (!t) return ''

  const mapped = map?.byBcartParent?.get(t)
  if (mapped) return mapped

  // ★ v系未マッピングは fail-closed（dealer ログイン側に存在しない値を
  //    orders.dealerCode に書き込むと集計から外れるため）
  if (/^v\d+$/.test(t)) {
    console.warn('[dealerCodeMapping] unmapped bcartParentId:', t)
    return ''
  }

  return t
}

/**
 * アプリ dealerCode → Bカート customer_parent_id に解決。
 *
 * 主にクエリ側（Bカート API で当該代理店の受注を照会）で使う。
 * 書込側ではないため fail-closed なし。
 *
 * @param {string|null|undefined} dealerCode
 * @param {{ byDealerCode: Map<string,string> }=} map
 * @returns {string}
 */
export function resolveBcartParent(dealerCode, map) {
  const t = String(dealerCode || '').trim()
  if (!t) return ''
  return map?.byDealerCode?.get(t) || t
}
