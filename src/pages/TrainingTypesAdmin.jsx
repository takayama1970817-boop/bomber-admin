import { useEffect, useState } from 'react'
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { assertCan, canManageTraining } from '../lib/permissions.js'

/**
 * 研修種別マスタ管理（PR-1 骨組み）
 * - コレクション: trainingTypes
 * - 画面から追加・編集・論理削除（isActive=false）
 * - 「初期マスタ投入」で basic_training / certified_salon_training / certified_salon_update を一括投入（冪等）
 * - 発行物種別（ディプロマ / 認定サロン賞）の有無フラグは PR-2 以降の発行ロジックで参照する
 */

const INITIAL_TYPES = [
  {
    code: 'basic_training',
    name: '基礎研修',
    issueDiploma: true,
    issueCertifiedSalonAward: false,
    sortOrder: 10,
    note: 'ディプロマのみ発行する基礎研修',
  },
  {
    code: 'certified_salon_training',
    name: '認定サロン研修',
    issueDiploma: true,
    issueCertifiedSalonAward: true,
    sortOrder: 20,
    note: 'ディプロマ + 認定サロン賞を発行',
  },
  {
    code: 'certified_salon_update',
    name: '認定更新研修',
    issueDiploma: false,
    issueCertifiedSalonAward: true,
    sortOrder: 30,
    note: '認定サロン賞のみ発行（更新）',
  },
]

const EMPTY_FORM = {
  code: '',
  name: '',
  issueDiploma: true,
  issueCertifiedSalonAward: false,
  sortOrder: 100,
  isActive: true,
  note: '',
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export default function TrainingTypesAdmin() {
  const { profile } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const canEdit = canManageTraining(profile)

  async function load() {
    setLoading(true)
    try {
      const snap = await getDocs(
        query(collection(db, 'trainingTypes'), orderBy('sortOrder', 'asc')),
      )
      setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setMessage(`読み込みエラー: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openNew() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function openEdit(row) {
    setEditingId(row.id)
    setForm({
      code: row.code || '',
      name: row.name || '',
      issueDiploma: !!row.issueDiploma,
      issueCertifiedSalonAward: !!row.issueCertifiedSalonAward,
      sortOrder: row.sortOrder ?? 100,
      isActive: row.isActive !== false,
      note: row.note || '',
    })
    setShowForm(true)
  }

  async function save() {
    try {
      assertCan(canManageTraining, profile, {
        userMessage: '研修種別マスタの編集権限がありません',
      })
      if (!form.code.trim() || !form.name.trim()) {
        setMessage('コードと研修名は必須です')
        return
      }
      setBusy(true)
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        issueDiploma: !!form.issueDiploma,
        issueCertifiedSalonAward: !!form.issueCertifiedSalonAward,
        sortOrder: Number(form.sortOrder) || 100,
        isActive: !!form.isActive,
        note: form.note || '',
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      }
      if (editingId) {
        await updateDoc(doc(db, 'trainingTypes', editingId), payload)
      } else {
        // code の重複チェック（簡易）
        const dup = await getDocs(
          query(collection(db, 'trainingTypes'), where('code', '==', payload.code)),
        )
        if (!dup.empty) {
          setMessage(`同じコード "${payload.code}" の研修種別が既にあります`)
          setBusy(false)
          return
        }
        await addDoc(collection(db, 'trainingTypes'), {
          ...payload,
          createdAt: serverTimestamp(),
          createdBy: profile?.uid || null,
        })
      }
      setShowForm(false)
      setMessage(editingId ? '更新しました' : '追加しました')
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`保存エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function seedInitial() {
    try {
      assertCan(canManageTraining, profile, {
        userMessage: '研修種別マスタの編集権限がありません',
      })
      if (!confirm('初期マスタ3件を投入します。既存コードはスキップされます。よろしいですか？')) return
      setBusy(true)
      let added = 0, skipped = 0
      for (const t of INITIAL_TYPES) {
        const dup = await getDocs(
          query(collection(db, 'trainingTypes'), where('code', '==', t.code)),
        )
        if (!dup.empty) { skipped++; continue }
        await addDoc(collection(db, 'trainingTypes'), {
          ...t,
          isActive: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: profile?.uid || null,
          updatedBy: profile?.uid || null,
        })
        added++
      }
      setMessage(`初期マスタ投入完了: 追加 ${added} / スキップ ${skipped}`)
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`投入エラー: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(row) {
    try {
      assertCan(canManageTraining, profile)
      await updateDoc(doc(db, 'trainingTypes', row.id), {
        isActive: !(row.isActive !== false),
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      })
      await load()
    } catch (e) {
      console.error(e)
      setMessage(`更新エラー: ${e.message}`)
    }
  }

  if (!canEdit) {
    return <div className="p-6 text-sm text-red-600">この画面の閲覧権限がありません。</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">研修種別マスタ</h1>
        <div className="flex gap-2">
          <button
            onClick={seedInitial}
            disabled={busy}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            初期マスタを投入
          </button>
          <button
            onClick={openNew}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + 研修種別を追加
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {message}
        </div>
      )}

      <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-3 py-2">コード</th>
              <th className="px-3 py-2">研修名</th>
              <th className="px-3 py-2 text-center">ディプロマ</th>
              <th className="px-3 py-2 text-center">認定サロン賞</th>
              <th className="px-3 py-2 text-center">並び順</th>
              <th className="px-3 py-2 text-center">状態</th>
              <th className="px-3 py-2">更新日</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">読み込み中...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                  研修種別が登録されていません。「初期マスタを投入」で3件まとめて追加できます。
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-center">{r.issueDiploma ? '○' : '—'}</td>
                <td className="px-3 py-2 text-center">{r.issueCertifiedSalonAward ? '○' : '—'}</td>
                <td className="px-3 py-2 text-center text-gray-500">{r.sortOrder ?? '—'}</td>
                <td className="px-3 py-2 text-center">
                  {r.isActive !== false ? (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">有効</span>
                  ) : (
                    <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600">無効</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(r.updatedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => openEdit(r)}
                    className="mr-2 text-sm text-indigo-600 hover:underline"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => toggleActive(r)}
                    className="text-sm text-gray-500 hover:underline"
                  >
                    {r.isActive !== false ? '無効化' : '有効化'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-bold">
              {editingId ? '研修種別を編集' : '研修種別を追加'}
            </h2>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-gray-600">コード（英数字・重複不可）</span>
                <input
                  type="text"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  disabled={!!editingId}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-50"
                  placeholder="basic_training"
                />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">研修名</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="基礎研修"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.issueDiploma}
                    onChange={(e) => setForm({ ...form, issueDiploma: e.target.checked })}
                  />
                  ディプロマを発行
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.issueCertifiedSalonAward}
                    onChange={(e) => setForm({ ...form, issueCertifiedSalonAward: e.target.checked })}
                  />
                  認定サロン賞を発行
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-gray-600">並び順</span>
                  <input
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  />
                  有効
                </label>
              </div>
              <label className="block text-sm">
                <span className="text-gray-600">備考</span>
                <textarea
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowForm(false)}
                disabled={busy}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {editingId ? '更新' : '追加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
