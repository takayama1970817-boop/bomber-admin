import { useEffect, useState } from 'react'
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
// PR-B（2026-04-25）: phase / mailStatus 分離仕様（src/lib/kickbackStatus.js）に準拠
import {
  derivePhase,
  deriveMailStatus,
  deriveDisplayLabel,
  displayBadgeClass,
  isPortalVisible,
  PHASE,
  MAIL_STATUS,
} from '../lib/kickbackStatus.js'

/**
 * dealer 自身のキックバック清算書を Firestore から取得する Hook。
 *
 * 設計方針:
 *   - Firestore のみ使用（BカートAPIは使わない）
 *   - 月次レコードなので orderBy('month', 'desc')
 *   - 直近 12ヶ月分取得。pagination なし
 *   - フィルタや集計はクライアント側で
 *
 * 横展開 Phase 3（2026-04-25）追加:
 *   - options.cacheKey 指定時、当日 localStorage キャッシュを読み書き
 *   - reload 関数を返却（キャッシュバイパスで再 fetch）
 *   - 0 件取得時は既存データを保持
 *
 * @param {Object} user - profile（dealerCode を含む）
 * @param {Object} options - { cacheKey?: string }
 */
export default function useDealerKickbacks(user, options = {}) {
  const cacheKey = options?.cacheKey || null
  const [kickbacks, setKickbacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadCounter, setReloadCounter] = useState(0)
  const reload = () => setReloadCounter((c) => c + 1)

  useEffect(() => {
    if (!user?.dealerCode) {
      setKickbacks([])
      setLoading(false)
      return
    }

    let cancelled = false

    // キャッシュ読み込み（reloadCounter==0 のみ）
    const today = new Date().toISOString().slice(0, 10)
    if (cacheKey && reloadCounter === 0) {
      try {
        const raw = localStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached.date === today && Array.isArray(cached.kickbacks) && cached.kickbacks.length > 0) {
            // タイムスタンプは ISO 文字列で保存されているため Date 化
            const restored = cached.kickbacks
              .map((kb) => ({
                ...kb,
                paidAt: kb.paidAt ? new Date(kb.paidAt) : null,
                scheduledAt: kb.scheduledAt ? new Date(kb.scheduledAt) : null,
                updatedAt: kb.updatedAt ? new Date(kb.updatedAt) : null,
                calculatedAt: kb.calculatedAt ? new Date(kb.calculatedAt) : null,
              }))
              // PR-B: 旧キャッシュに calculating / skeleton が混入していたら除外
              .filter((kb) => isPortalVisible(kb) && !kb.isSkeleton)
            setKickbacks(restored)
            setLoading(false)
            setError(null)
            return () => { cancelled = true }
          }
        }
      } catch (e) { console.warn('useDealerKickbacks cache read failed:', e) }
    }

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
        const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        // PR-B: phase='calculating' は代理店ポータル非表示（要件 §6）
        // skeleton（isSkeleton=true）も非表示。集計済み以降のみ dealer に出す。
        const list = raw.filter((kb) => isPortalVisible(kb) && !kb.isSkeleton)
        // 0件取得で既存データを上書きしない（fullSync 横展開要件）
        if (list.length === 0 && kickbacks.length > 0) {
          console.warn('[useDealerKickbacks] 0 件取得のため既存データを保持')
          return
        }
        setKickbacks(list)
        // キャッシュ保存（タイムスタンプは ISO 化）
        if (cacheKey) {
          try {
            const tsToISO = (ts) => {
              if (!ts) return null
              const sec = ts._seconds ?? ts.seconds
              if (sec) return new Date(sec * 1000).toISOString()
              if (typeof ts.toDate === 'function') return ts.toDate().toISOString()
              if (ts instanceof Date) return ts.toISOString()
              const d = new Date(ts)
              return isNaN(d.getTime()) ? null : d.toISOString()
            }
            const serialised = list.map((kb) => ({
              ...kb,
              paidAt: tsToISO(kb.paidAt),
              scheduledAt: tsToISO(kb.scheduledAt),
              updatedAt: tsToISO(kb.updatedAt),
              calculatedAt: tsToISO(kb.calculatedAt),
            }))
            localStorage.setItem(cacheKey, JSON.stringify({ date: today, kickbacks: serialised }))
          } catch (e) { console.warn('useDealerKickbacks cache write failed:', e) }
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.dealerCode, reloadCounter])

  return { kickbacks, loading, error, reload }
}

/**
 * PR-B: phase + mailStatus を反映した「5 値ラベル」を返す。
 *   計算中 / 計算済み / PDF作成済み（メール未送信）/ メール送信済み / メール送信失敗
 *
 * 旧 normalizeKickbackStatus / KICKBACK_STATUS_LABELS / KICKBACK_STATUS_BADGE は
 * 後方互換のため残すが、新規コードは deriveDisplayLabel を直接 import すること。
 */
export function normalizeKickbackStatus(kb) {
  // 後方互換: 旧キー（draft/calculated/approved/paid）を返し続ける
  if (!kb) return 'draft'
  const raw = String(kb.status || '').toLowerCase()
  if (raw === 'paid' || kb.paidAt) return 'paid'
  if (raw === 'approved') return 'approved'
  if (raw === 'draft') return 'draft'
  return 'calculated'
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

// PR-B: 新仕様の helper を再 export（呼び出し側の import を 1 箇所にまとめるため）
export {
  derivePhase,
  deriveMailStatus,
  deriveDisplayLabel,
  displayBadgeClass,
  PHASE,
  MAIL_STATUS,
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
 * PR-B: PDF ダウンロード可否
 * - pdfUrl があれば常に可。mailStatus は問わない（要件: メール送信と分離）
 * - 旧 approved/paid 縛りは廃止（docs/KICKBACK_REQUIREMENTS.md §6）
 */
export function canDownloadKickbackPdf(kb) {
  return !!kb?.pdfUrl
}

/**
 * PR-B 新設: CSV ダウンロード可否
 * - csvUrl があれば常に可。mailStatus は問わない
 */
export function canDownloadKickbackCsv(kb) {
  return !!kb?.csvUrl
}

/** 新しいタブで PDF を開く。ブラウザ標準のPDFビューワに委ねる。 */
export function openKickbackPdf(url) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** PR-B: 新しいタブで CSV を開く（ブラウザのデフォルト挙動でダウンロード） */
export function openKickbackCsv(url) {
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
