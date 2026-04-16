import { useEffect, useState } from 'react'
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

const today = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const fmtTime = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

const fmtMin = (m) => {
  if (!m && m !== 0) return '—'
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}時間${mm}分` : `${mm}分`
}

const calcWorkMinutes = (rec) => {
  if (!rec?.clockIn || !rec?.clockOut) return null
  const inT = rec.clockIn.toDate ? rec.clockIn.toDate() : new Date(rec.clockIn)
  const outT = rec.clockOut.toDate ? rec.clockOut.toDate() : new Date(rec.clockOut)
  const totalMin = Math.max(0, Math.round((outT - inT) / 60000))
  return Math.max(0, totalMin - (rec.breakMinutes || 0))
}

export default function Attendance() {
  const { user } = useAuth()
  const [record, setRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [memo, setMemo] = useState('')

  const docId = user ? `${user.uid}_${today()}` : null

  useEffect(() => {
    if (!docId) return
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, 'attendance', docId))
        if (snap.exists()) {
          const d = snap.data()
          setRecord(d)
          setMemo(d.memo ?? '')
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [docId])

  const clockIn = async () => {
    if (!user) return
    setBusy(true)
    try {
      const data = {
        uid: user.uid,
        date: today(),
        clockIn: serverTimestamp(),
        clockOut: null,
        breakStart: null,
        breakEnd: null,
        breakMinutes: 0,
        memo: '',
      }
      await setDoc(doc(db, 'attendance', docId), data)
      setRecord({ ...data, clockIn: new Date() })
    } catch (e) {
      console.error(e)
      alert('出勤打刻に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const breakStart = async () => {
    setBusy(true)
    try {
      await updateDoc(doc(db, 'attendance', docId), {
        breakStart: serverTimestamp(),
        breakEnd: null,
      })
      setRecord((r) => ({ ...r, breakStart: new Date(), breakEnd: null }))
    } catch (e) {
      console.error(e)
      alert('休憩開始の記録に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const breakEnd = async () => {
    setBusy(true)
    try {
      const now = new Date()
      const startT = record.breakStart?.toDate
        ? record.breakStart.toDate()
        : new Date(record.breakStart)
      const addMin = Math.max(0, Math.round((now - startT) / 60000))
      const newBreakMinutes = (record.breakMinutes || 0) + addMin
      await updateDoc(doc(db, 'attendance', docId), {
        breakEnd: serverTimestamp(),
        breakMinutes: newBreakMinutes,
      })
      setRecord((r) => ({
        ...r,
        breakEnd: now,
        breakMinutes: newBreakMinutes,
      }))
    } catch (e) {
      console.error(e)
      alert('休憩終了の記録に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const clockOut = async () => {
    setBusy(true)
    try {
      // 休憩中だったら自動で休憩終了させる
      let updates = { clockOut: serverTimestamp(), memo }
      if (record?.breakStart && !record?.breakEnd) {
        const now = new Date()
        const startT = record.breakStart.toDate
          ? record.breakStart.toDate()
          : new Date(record.breakStart)
        const addMin = Math.max(0, Math.round((now - startT) / 60000))
        updates.breakEnd = serverTimestamp()
        updates.breakMinutes = (record.breakMinutes || 0) + addMin
      }
      await updateDoc(doc(db, 'attendance', docId), updates)
      setRecord((r) => ({
        ...r,
        ...updates,
        clockOut: new Date(),
        ...(updates.breakEnd ? { breakEnd: new Date() } : {}),
      }))
    } catch (e) {
      console.error(e)
      alert('退勤打刻に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="text-gray-500">読み込み中...</div>

  const isClockedIn = !!record?.clockIn
  const isClockedOut = !!record?.clockOut
  const isOnBreak = !!record?.breakStart && !record?.breakEnd
  const workMin = calcWorkMinutes(record)

  return (
    <div className="max-w-xl">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">勤怠打刻</h1>
      <p className="mb-6 text-sm text-gray-500">{today()}</p>

      <div className="rounded-2xl border border-gray-200 bg-white p-8">
        <div className="mb-6 grid grid-cols-2 gap-4 text-center">
          <div>
            <div className="text-xs text-gray-500">出勤</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">
              {fmtTime(record?.clockIn)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">退勤</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">
              {fmtTime(record?.clockOut)}
            </div>
          </div>
        </div>

        {isClockedIn && (
          <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-4 text-center text-sm">
            <div>
              <div className="text-xs text-gray-500">休憩合計</div>
              <div className="mt-1 font-semibold text-gray-900">
                {fmtMin(record?.breakMinutes ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">勤務時間</div>
              <div className="mt-1 font-semibold text-gray-900">
                {workMin === null ? '—' : fmtMin(workMin)}
              </div>
            </div>
          </div>
        )}

        {isOnBreak && (
          <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
            ☕ 休憩中（{fmtTime(record?.breakStart)} 〜）
          </div>
        )}

        <div className="mb-4">
          <label className="mb-1 block text-xs text-gray-500">メモ</label>
          <textarea
            rows={3}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            disabled={isClockedOut}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-gray-50"
          />
        </div>

        <div className="space-y-3">
          {!isClockedIn && (
            <button
              onClick={clockIn}
              disabled={busy}
              className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              出勤
            </button>
          )}

          {isClockedIn && !isClockedOut && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {!isOnBreak ? (
                  <button
                    onClick={breakStart}
                    disabled={busy}
                    className="rounded-lg border border-amber-500 bg-white px-4 py-3 text-sm font-medium text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                  >
                    休憩開始
                  </button>
                ) : (
                  <button
                    onClick={breakEnd}
                    disabled={busy}
                    className="rounded-lg bg-amber-500 px-4 py-3 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    休憩終了
                  </button>
                )}
                <button
                  onClick={clockOut}
                  disabled={busy}
                  className="rounded-lg bg-gray-900 px-4 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  退勤
                </button>
              </div>
            </>
          )}

          {isClockedOut && (
            <div className="rounded-lg bg-green-50 px-4 py-3 text-center text-sm text-green-700">
              ✅ 本日の勤務は終了しました
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
