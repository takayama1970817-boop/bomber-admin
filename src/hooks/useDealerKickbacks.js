import { useEffect, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * dealer 自身のキックバック清算書を Firestore から取得する Hook。
 *
 * 設計方針:
 *   - Firestore のみ使用（BカートAPIは使わない）
 *   - 月次レコードなので orderBy('month', 'desc')
 *   - 直近 12ヶ月分取得。pagination なし
 *   - フィルタや集計はクライアント側で
 *
 * @param {Object} user - profile（dealerCode を含む）
 */
export default function useDealerKickbacks(user) {
  const [kickbacks, setKickbacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!user?.dealerCode) {
      setKickbacks([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    const q = query(
      collection(db, 'kickbacks'),
      where('dealerCode', '==', user.dealerCode),
      orderBy('month', 'desc'),
      limit(12),
    )

    getDocs(q)
      .then((snap) => {
        if (cancelled) return
        setKickbacks(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      })
      .catch((e) => {
        console.error('useDealerKickbacks fetch error:', e)
        if (!cancelled) setError(e?.message || '取得に失敗しました')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [user?.dealerCode])

  return { kickbacks, loading, error }
}

// ステータス正規化。kickbacks ドキュメントには status フィールドが無い可能性があるため、
// 存在しない場合は「計算済み」（記録がある＝計算完了とみなす）扱い。
export function normalizeKickbackStatus(kb) {
  if (!kb) return 'draft'
  const raw = String(kb.status || '').toLowerCase()
  if (raw === 'paid' || kb.paidAt) return 'paid'
  if (raw === 'approved') return 'approved'
  if (raw === 'draft') return 'draft'
  return 'calculated' // デフォルト: 記録あり = 計算済み
}

export const KICKBACK_STATUS_LABELS = {
  draft: '計算中',
  calculated: '計算済み',
  approved: '承認済み',
  paid: '支払済み',
}

export const KICKBACK_STATUS_BADGE = {
  draft: 'bg-gray-100 text-gray-700',
  calculated: 'bg-blue-100 text-blue-700',
  approved: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
}

/**
 * kickback ドキュメントから「キックバック額」を安全に取得。
 * 優先順位: finalSettlement > grandTotal > totalKickback > amount
 */
export function extractKickbackAmount(kb) {
  if (!kb) return 0
  return Number(kb.finalSettlement ?? kb.grandTotal ?? kb.totalKickback ?? kb.amount ?? 0) || 0
}

/**
 * 対象売上額を安全に取得。
 */
export function extractSalesAmount(kb) {
  if (!kb) return 0
  return Number(kb.totalSales ?? kb.salesAmount ?? 0) || 0
}

/**
 * PDF ダウンロード可否。
 * - pdfUrl が存在することが第一条件
 * - ステータスが approved / paid に達していること
 *
 * 備考:
 *   現状 kickbacks ドキュメントには status フィールドが未整備のため、
 *   status が欠落している場合は pdfUrl の有無だけで判定するフォールバック付き。
 *   将来 status が本格運用されたら、この分岐を削除してもよい。
 */
export function canDownloadKickbackPdf(kb) {
  if (!kb?.pdfUrl) return false
  const status = normalizeKickbackStatus(kb)
  // フォールバック: status が未整備（= 'calculated' に正規化）でも、
  // 明示 status 未保存なら pdfUrl だけで許可する
  if (!kb.status) return true
  return status === 'approved' || status === 'paid'
}

/** 新しいタブで PDF を開く。ブラウザ標準のPDFビューワに委ねる。 */
export function openKickbackPdf(url) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 料率を推定（保存値があればそれを、なければ計算）。
 */
export function extractRate(kb) {
  if (!kb) return null
  if (kb.rate != null) return Number(kb.rate)
  const sales = extractSalesAmount(kb)
  const kick = Number(kb.totalKickback ?? 0)
  if (sales > 0 && kick > 0) return kick / sales
  return null
}
