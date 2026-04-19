import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * 代理店ダッシュボード用の日次スナップショットを 1件だけ取得する。
 * 重い集計は scripts/aggregate-dealer-monthly.mjs 側で完了している前提。
 *
 * 戻り値:
 *   { loading, error, snapshot }
 *     snapshot === null のとき「まだ集計されていない」 or 「データなし」。
 *     画面側で「データがありません」表示に分岐する。
 */
export function useDealerDashboard(dealerCode, month) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [snapshot, setSnapshot] = useState(null)

  useEffect(() => {
    if (!dealerCode || !month) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const ref = doc(db, 'dealerMonthlySnapshots', `${dealerCode}_${month}`)
        const snap = await getDoc(ref)
        if (cancelled) return
        setSnapshot(snap.exists() ? { id: snap.id, ...snap.data() } : null)
      } catch (e) {
        if (cancelled) return
        console.error('dealerMonthlySnapshots 取得エラー:', e)
        setError(e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dealerCode, month])

  return { loading, error, snapshot }
}

export function currentYearMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
