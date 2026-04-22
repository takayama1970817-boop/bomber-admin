import { useEffect, useMemo, useState } from 'react'
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { assertCan, canManageInstructor } from '../lib/permissions.js'

/**
 * 認定インストラクター マスタ管理（PR-B 導入 2026-04-22）
 *
 * - コレクション: certifiedInstructors
 * - 画面から追加・編集・論理無効化（isActive=false）
 * - 講座紐付け: certifications は trainingTypeId の配列（複数選択可）
 * - 権限: RT（admin/master）のみ
 */

const EMPTY_FORM = {
  name: '',
  nameKana: '',
  certifications: [],
  dealerCode: '',
  salonId: '',
  email: '',
  phone: '',
  isActive: true,
  note: '',
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export default function CertifiedInstructorsAdmin() {
  const { profile } = useAuth()
  const [rows, setRows] = useState([])
  const [types, setTypes] = useState([])
  const [dealers, setDealers] = useState([])
  const [salons, setSalons] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const canEdit = canManageInstructor(profile)

  async function load() {
    setLoading(true)
    try {
      const [instSnap, typesSnap, dealersSnap, salonsSnap] = await Promise.all([
        getDocs(query(collection(db, 'certifiedInstructors'), orderBy('name', 'asc'))),
        getDocs(query(collection(db, 'trainingTypes'), orderBy('sortOrder', 'asc'))),
        getDocs(collection(db, 'dealers')).catch(() => ({ docs: [] })),
        getDocs(collection(db, 'salons')).catch(() => ({ docs: [] })),
      ])
      setRows(instSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setTypes(typesSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setDealers(dealersSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setSalons(salonsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setMessage(`読み込みエラー: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const typeById = useMemo(() => {
    const m = {}
    types.forEach((t) => { m[t.id] = t })
    return m
  }, [types])

  function openNew() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function openEdit(row) {
    setEditingId(row.id)
    setForm({
      name: row.name || '',
      nameKana: row.nameKana || '',
      certifications: Array.isArray(row.certifications) ? [...row.certifications] : [],
      dealerCode: row.dealerCode || '',
      salonId: row.salonId || '',
      email: row.email || '',
      phone: row.phone || '',
      isActive: row.isActive !== false,
      note: row.note || '',
    })
    setShowForm(true)
  }

  function toggleCertification(tid) {
    setForm((prev) => {
      const set = new Set(prev.certifications)
      if (set.has(tid)) set.delete(tid)
      else set.add(tid)
      return { ...prev, certifications: [...set] }
    })
  }

  async function save() {
    try {
      assertCan(canManageInstructor, profile, {
        userMessage: '認定インストラクターの編集権限がありません',
      })
      if (!form.name.trim()) {
        setMessage('講師名は必須です')
        return
      }
      setBusy(true)
      const payload = {
        name: form.name.trim(),
        nameKana: form.nameKana || '',
        certifications: form.certifications || [],
        dealerCode: form.dealerCode || '',
        salonId: form.salonId || '',
        email: form.email || '',
        phone: form.phone || '',
        isActive: !!form.isActive,
        note: form.note || '',
        updatedAt: serverTimestamp(),
        updatedBy: profile?.uid || null,
      }
      if (editingId) {
        await updateDoc(doc(db, 'certifiedInstructors', editingId), payload)
      } else {
        await addDoc(collection(db, 'certifiedInstructors'), {
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

  async function toggleActive(row) {
    try {
      assertCan(canManageInstructor, profile)
      await updateDoc(doc(db, 'certifiedInstructors', row.id), {
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
        <h1 className="text-2xl font-bold">認定インストラクターマスタ</h1>
        <div className="flex gap-2">
          <button
            onClick={openNew}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + インストラクターを追加
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
              <th className="px-3 py-2">講師名</th>
              <th className="px-3 py-2">フリガナ</th>
              <th className="px-3 py-2">担当講座</th>
              <th className="px-3 py-2">代理店</th>
              <th className="px-3 py-2">サロン</th>
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
                  認定インストラクターが登録されていません。「+ インストラクターを追加」から登録してください。
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const dealerLabel = dealers.find((d) => d.dealerCode === r.dealerCode)
              const salonLabel = salons.find((s) => s.id === r.salonId)
              return (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.nameKana || '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {(r.certifications || []).length === 0 ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {(r.certifications || []).map((tid) => (
                          <span key={tid} className="rounded bg-indigo-100 px-2 py-0.5 text-[11px] text-indigo-700">
                            {typeById[tid]?.name || tid}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {r.dealerCode ? (
                      <>[{r.dealerCode}] {dealerLabel?.companyName || dealerLabel?.name || '—'}</>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {r.salonId ? (salonLabel?.companyName || salonLabel?.name || r.salonId) : <span className="text-gray-400">—</span>}
                  </td>
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
              )
            })}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-bold">
              {editingId ? 'インストラクターを編集' : 'インストラクターを追加'}
            </h2>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="text-gray-600">講師名（必須）</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">フリガナ</span>
                <input
                  type="text"
                  value={form.nameKana}
                  onChange={(e) => setForm({ ...form, nameKana: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>

              <div className="block text-sm">
                <span className="text-gray-600">担当講座（複数選択可）</span>
                <div className="mt-1 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 p-2">
                  {types.length === 0 ? (
                    <div className="text-xs text-gray-400">研修種別マスタが空です</div>
                  ) : (
                    types.map((t) => (
                      <label key={t.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <input
                          type="checkbox"
                          checked={form.certifications.includes(t.id)}
                          onChange={() => toggleCertification(t.id)}
                        />
                        <span>{t.name}</span>
                        {t.isActive === false && (
                          <span className="rounded bg-gray-200 px-1 text-[10px] text-gray-500">無効</span>
                        )}
                      </label>
                    ))
                  )}
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  ここで選択した講座のみ、申込画面でこの講師が候補に表示されます。
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-gray-600">代理店（任意）</span>
                  <select
                    value={form.dealerCode}
                    onChange={(e) => setForm({ ...form, dealerCode: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">未指定</option>
                    {dealers.filter((d) => d.dealerCode).map((d) => (
                      <option key={d.id} value={d.dealerCode}>
                        [{d.dealerCode}] {d.companyName || d.name || d.dealerName || d.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">サロン（任意）</span>
                  <select
                    value={form.salonId}
                    onChange={(e) => setForm({ ...form, salonId: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">未指定</option>
                    {salons.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.companyName || s.name || s.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-gray-600">メール（任意）</span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">電話（任意）</span>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                有効（無効化すると申込画面の候補に出なくなります）
              </label>

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
