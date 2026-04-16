import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

const FOLLOW_DAYS = 30 // 「フォロー必要」判定の日数閾値

const isFollowNeeded = (s) => {
  if (!s.lastOrderDate) return true // 1回も発注なし
  const last = s.lastOrderDate.toDate
    ? s.lastOrderDate.toDate()
    : new Date(s.lastOrderDate)
  const days = (Date.now() - last.getTime()) / (1000 * 60 * 60 * 24)
  return days >= FOLLOW_DAYS
}

export default function Salons() {
  const { profile, isAdmin } = useAuth()
  const [salons, setSalons] = useState([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState('all') // all | mine | follow

  useEffect(() => {
    ;(async () => {
      try {
        const q = query(collection(db, 'salons'), orderBy('name'))
        const snap = await getDocs(q)
        setSalons(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const filtered = useMemo(() => {
    let list = salons
    if (filter === 'mine') {
      list = list.filter((s) => s.assignedUid === profile?.uid)
    } else if (filter === 'follow') {
      list = list.filter(isFollowNeeded)
    }
    if (keyword) {
      const k = keyword.toLowerCase()
      list = list.filter(
        (s) =>
          s.name?.toLowerCase().includes(k) ||
          s.contact?.toLowerCase().includes(k) ||
          s.email?.toLowerCase().includes(k),
      )
    }
    return list
  }, [salons, keyword, filter, profile])

  const filterButton = (key, label, count) => (
    <button
      onClick={() => setFilter(key)}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        filter === key
          ? 'bg-indigo-600 text-white'
          : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="ml-1.5 opacity-80">({count})</span>
      )}
    </button>
  )

  const counts = useMemo(
    () => ({
      all: salons.length,
      mine: salons.filter((s) => s.assignedUid === profile?.uid).length,
      follow: salons.filter(isFollowNeeded).length,
    }),
    [salons, profile],
  )

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">サロン管理</h1>
        <input
          type="text"
          placeholder="サロン名・担当者・メールで検索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          className="w-80 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div className="mb-4 flex gap-2">
        {filterButton('all', '全て', counts.all)}
        {filterButton('mine', '自分の担当', counts.mine)}
        {filterButton('follow', `フォロー必要（${FOLLOW_DAYS}日超）`, counts.follow)}
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">サロン名</th>
              <th className="px-4 py-3">サロン担当</th>
              <th className="px-4 py-3">プラン</th>
              <th className="px-4 py-3">Bカート</th>
              <th className="px-4 py-3">最終発注</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  読み込み中...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  サロンが見つかりません
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-gray-100 hover:bg-gray-50"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/salons/${s.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      {s.name}
                    </Link>
                    {isFollowNeeded(s) && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                        要フォロー
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{s.contact}</td>
                  <td className="px-4 py-3 text-gray-700">{s.plan}</td>
                  <td className="px-4 py-3">
                    {s.bcartRegistered ? (
                      <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
                        登録済
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                        未登録
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {s.lastOrderDate?.toDate?.().toLocaleDateString('ja-JP') ??
                      '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
