import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import OrderHistory from '../components/OrderHistory.jsx'

const FIELDS = [
  ['name', 'サロン名'],
  ['contact', '担当者（サロン側）'],
  ['phone', '電話番号'],
  ['email', 'メール'],
  ['plan', '契約プラン'],
]

export default function SalonDetail() {
  const { id } = useParams()
  const { isAdmin, profile } = useAuth()
  const [salon, setSalon] = useState(null)
  const [staffList, setStaffList] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const reloadSalon = async () => {
    const snap = await getDoc(doc(db, 'salons', id))
    if (snap.exists()) {
      setSalon({ id: snap.id, ...snap.data() })
    }
  }

  useEffect(() => {
    ;(async () => {
      try {
        await reloadSalon()
        // admin のみ全スタッフ取得（assignedUid 変更用）
        if (isAdmin) {
          const usersSnap = await getDocs(collection(db, 'users'))
          setStaffList(usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() })))
        }
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isAdmin])

  const onChange = (k, v) => setSalon((s) => ({ ...s, [k]: v }))

  const canEdit =
    isAdmin || (salon && salon.assignedUid === profile?.uid)

  const save = async () => {
    if (!salon) return
    setSaving(true)
    try {
      const { id: _id, ...data } = salon
      await updateDoc(doc(db, 'salons', id), {
        ...data,
        updatedAt: serverTimestamp(),
      })
      alert('保存しました')
    } catch (e) {
      console.error(e)
      alert('保存に失敗しました: ' + (e?.code || e?.message || ''))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-gray-500">読み込み中...</div>
  if (!salon) {
    return (
      <div>
        <p className="mb-4 text-gray-500">サロンが見つかりませんでした</p>
        <Link to="/salons" className="text-indigo-600 hover:underline">
          ← 一覧に戻る
        </Link>
      </div>
    )
  }

  const assignedStaff = staffList.find((s) => s.uid === salon.assignedUid)

  return (
    <div className="max-w-3xl">
      <Link to="/salons" className="text-sm text-indigo-600 hover:underline">
        ← 一覧に戻る
      </Link>
      <h1 className="mt-2 mb-6 text-2xl font-bold text-gray-900">
        {salon.name || '(無題)'}
      </h1>

      {!canEdit && (
        <div className="mb-4 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
          ⚠️ あなたはこのサロンの担当ではないため、編集できません（閲覧のみ）
        </div>
      )}

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6">
        {FIELDS.map(([key, label]) => (
          <div key={key}>
            <label className="mb-1 block text-xs text-gray-500">{label}</label>
            <input
              type="text"
              value={salon[key] ?? ''}
              onChange={(e) => onChange(key, e.target.value)}
              disabled={!canEdit}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-gray-50"
            />
          </div>
        ))}

        {/* 社内営業担当 */}
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            社内の担当営業
          </label>
          {isAdmin ? (
            <select
              value={salon.assignedUid ?? ''}
              onChange={(e) => onChange('assignedUid', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              <option value="">— 未割当 —</option>
              {staffList.map((s) => (
                <option key={s.uid} value={s.uid}>
                  {s.name || s.email}（{s.role}）
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {assignedStaff?.name || assignedStaff?.email || '未割当'}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            id="bcart"
            type="checkbox"
            checked={!!salon.bcartRegistered}
            onChange={(e) => onChange('bcartRegistered', e.target.checked)}
            disabled={!canEdit}
            className="h-4 w-4"
          />
          <label htmlFor="bcart" className="text-sm text-gray-700">
            Bカート登録済み
          </label>
        </div>

        <div>
          <label className="mb-1 block text-xs text-gray-500">メモ</label>
          <textarea
            rows={4}
            value={salon.notes ?? ''}
            onChange={(e) => onChange('notes', e.target.value)}
            disabled={!canEdit}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-gray-50"
          />
        </div>

        {canEdit && (
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        )}
      </div>

      {/* 発注履歴セクション */}
      <div className="mt-6">
        <OrderHistory
          salonId={id}
          currentLastOrderDate={salon.lastOrderDate}
          onOrderAdded={reloadSalon}
        />
      </div>
    </div>
  )
}
