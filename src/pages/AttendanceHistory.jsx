import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

const ymToRange = (ym) => {
  // ym = "YYYY-MM"
  const [y, m] = ym.split('-').map(Number)
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const nextM = m === 12 ? '01' : String(m + 1).padStart(2, '0')
  const nextY = m === 12 ? y + 1 : y
  const end = `${nextY}-${nextM}-01`
  return [start, end]
}

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function AttendanceHistory() {
  const { user } = useAuth()
  const [month, setMonth] = useState(currentMonth())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    ;(async () => {
      setLoading(true)
      try {
        const [start, end] = ymToRange(month)
        const q = query(
          collection(db, 'attendance'),
          where('uid', '==', user.uid),
          where('date', '>=', start),
          where('date', '<', end),
          orderBy('date'),
        )
        const snap = await getDocs(q)
        setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })()
  }, [user, month])

  const totalMinutes = useMemo(() => {
    return rows.reduce((sum, r) => {
      if (!r.clockIn || !r.clockOut) return sum
      const inT = r.clockIn.toDate?.() ?? new Date(r.clockIn)
      const outT = r.clockOut.toDate?.() ?? new Date(r.clockOut)
      const mins = Math.max(0, (outT - inT) / 60000 - (r.breakMinutes || 0))
      return sum + mins
    }, 0)
  }, [rows])

  const hours = Math.floor(totalMinutes / 60)
  const minutes = Math.round(totalMinutes % 60)

  const fmt = (t) => {
    if (!t) return '—'
    const d = t.toDate ? t.toDate() : new Date(t)
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">勤怠履歴</h1>

      <div className="mb-6 flex items-center gap-4">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="rounded-lg bg-indigo-50 px-4 py-2 text-sm text-indigo-700">
          合計: {hours}時間 {minutes}分 / {rows.length}日
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">日付</th>
              <th className="px-4 py-3">出勤</th>
              <th className="px-4 py-3">退勤</th>
              <th className="px-4 py-3">休憩(分)</th>
              <th className="px-4 py-3">メモ</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  読み込み中...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  データがありません
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">{r.date}</td>
                  <td className="px-4 py-3">{fmt(r.clockIn)}</td>
                  <td className="px-4 py-3">{fmt(r.clockOut)}</td>
                  <td className="px-4 py-3 text-gray-700">{r.breakMinutes ?? 0}</td>
                  <td className="px-4 py-3 text-gray-500">{r.memo}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
