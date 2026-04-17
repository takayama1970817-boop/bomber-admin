import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  increment,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import {
  canCreateCustomer,
  canEditCustomer,
  canDeleteCustomer,
  canImportCsv,
  canAddVisit,
  canEditVisit,
  canDeleteVisit,
  assertCan,
} from '../lib/permissions.js'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '¥0'
  return '¥' + Number(n).toLocaleString()
}

function daysSince(ts) {
  if (!ts) return null
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

const SKIN_TYPE_OPTIONS = ['乾燥', '敏感', '混合', '脂性', '普通', 'エイジング']
const CONCERN_OPTIONS = ['シミ', 'たるみ', 'シワ', '毛穴', 'ニキビ', 'くすみ', '赤み', '乾燥']

export default function SalonCustomers() {
  const { profile } = useAuth()
  const allowCreate = canCreateCustomer(profile)
  const allowEdit = canEditCustomer(profile)
  const allowImport = canImportCsv(profile)
  const companyName = profile?.companyName || ''

  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [showImport, setShowImport] = useState(false)

  const loadCustomers = async () => {
    if (!companyName) { setLoading(false); return }
    setLoading(true)
    try {
      const snap = await getDocs(
        query(
          collection(db, 'customers'),
          where('salonCompanyName', '==', companyName),
          orderBy('lastVisit', 'desc'),
        ),
      )
      setCustomers(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('顧客取得エラー:', e)
      try {
        const snap2 = await getDocs(
          query(
            collection(db, 'customers'),
            where('salonCompanyName', '==', companyName),
          ),
        )
        setCustomers(snap2.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e2) {
        console.error('再取得失敗:', e2)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCustomers() }, [companyName])

  const filtered = useMemo(() => {
    let list = customers
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(
        (c) =>
          (c.name || '').toLowerCase().includes(s) ||
          (c.nameKana || '').toLowerCase().includes(s) ||
          (c.phone || '').includes(search),
      )
    }
    if (filter === 'needFollow') {
      list = list.filter((c) => {
        const d = daysSince(c.lastVisit)
        return d != null && d >= 45
      })
    }
    if (filter === 'birthday') {
      const thisMonth = new Date().getMonth() + 1
      list = list.filter((c) => {
        if (!c.birthday) return false
        const b = c.birthday.toDate ? c.birthday.toDate() : new Date(c.birthday)
        return b.getMonth() + 1 === thisMonth
      })
    }
    return list
  }, [customers, search, filter])

  const kpi = useMemo(() => {
    const total = customers.length
    const needFollow = customers.filter((c) => {
      const d = daysSince(c.lastVisit)
      return d != null && d >= 45
    }).length
    const thisMonth = new Date().getMonth() + 1
    const birthdayThisMonth = customers.filter((c) => {
      if (!c.birthday) return false
      const b = c.birthday.toDate ? c.birthday.toDate() : new Date(c.birthday)
      return b.getMonth() + 1 === thisMonth
    }).length
    return { total, needFollow, birthdayThisMonth }
  }, [customers])

  const selected = customers.find((c) => c.id === selectedId)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">顧客管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            来店履歴・肌状態・店販提案を一元管理します
          </p>
        </div>
        <div className="flex gap-2">
          {allowImport && (
            <button
              onClick={() => setShowImport(true)}
              className="rounded-lg border border-pink-300 bg-white px-4 py-2 text-sm font-medium text-pink-700 hover:bg-pink-50"
            >
              📥 CSV取込
            </button>
          )}
          {allowCreate && (
            <button
              onClick={() => { setEditing(null); setShowForm(true) }}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              + 新規顧客
            </button>
          )}
          {!allowCreate && (
            <button
              type="button"
              onClick={() => alert('この画面は現在「閲覧のみ」権限で開いています。\n\n新規追加・編集・削除を行うには権限が必要です。\n担当管理者にアカウントの権限変更を依頼してください。')}
              className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600 hover:bg-gray-100 cursor-pointer"
              title="権限がありません"
            >
              🔒 閲覧のみ
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">登録顧客数</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{kpi.total}名</div>
        </div>
        <div className="rounded-xl border border-pink-200 bg-pink-50 p-4">
          <div className="text-xs text-pink-700">フォローが必要</div>
          <div className="mt-1 text-2xl font-bold text-pink-700">{kpi.needFollow}名</div>
          <div className="text-[10px] text-pink-600">45日以上未来店</div>
        </div>
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
          <div className="text-xs text-yellow-700">今月誕生日</div>
          <div className="mt-1 text-2xl font-bold text-yellow-700">{kpi.birthdayThisMonth}名</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          placeholder="名前・フリガナ・電話番号で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          {[
            { v: 'all', l: 'すべて' },
            { v: 'needFollow', l: 'フォロー必要' },
            { v: 'birthday', l: '今月誕生日' },
          ].map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`rounded-lg px-3 py-2 text-xs font-medium ${
                filter === f.v
                  ? 'bg-pink-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {f.l}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          読み込み中…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
          {customers.length === 0 ? '顧客がまだ登録されていません。「+ 新規顧客」または「📥 CSV取込」から登録してください。' : '該当する顧客がいません。'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">お客様</th>
                  <th className="px-4 py-3 text-left">最終来店</th>
                  <th className="px-4 py-3 text-right">来店回数</th>
                  <th className="px-4 py-3 text-right">累計売上</th>
                  <th className="px-4 py-3 text-left">肌タイプ</th>
                  <th className="px-4 py-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((c) => {
                  const days = daysSince(c.lastVisit)
                  const needFollow = days != null && days >= 45
                  return (
                    <tr
                      key={c.id}
                      className={`${selectedId === c.id ? 'bg-pink-50' : 'hover:bg-gray-50'} cursor-pointer`}
                      onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{c.name || '—'}</div>
                        {c.nameKana && (
                          <div className="text-xs text-gray-500">{c.nameKana}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-gray-700">{fmtDate(c.lastVisit)}</div>
                        {days != null && (
                          <div className={`text-xs ${needFollow ? 'text-pink-600 font-bold' : 'text-gray-400'}`}>
                            {needFollow ? `⚠ ${days}日経過` : `${days}日前`}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{c.visitCount || 0}回</td>
                      <td className="px-4 py-3 text-right">{fmtYen(c.totalSpent)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(c.skinType || []).slice(0, 3).map((t) => (
                            <span key={t} className="rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-pink-700">
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {allowEdit && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditing(c)
                              setShowForm(true)
                            }}
                            className="text-xs text-pink-600 hover:underline"
                          >
                            編集
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && (
        <CustomerDetail
          customer={selected}
          onClose={() => setSelectedId(null)}
          onChanged={loadCustomers}
        />
      )}

      {showForm && (
        <CustomerForm
          companyName={companyName}
          editing={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSaved={() => { setShowForm(false); setEditing(null); loadCustomers() }}
        />
      )}

      {showImport && (
        <CsvImportModal
          companyName={companyName}
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); loadCustomers() }}
        />
      )}
    </div>
  )
}

// ============================
// 顧客フォーム（新規/編集）
// ============================
function CustomerForm({ companyName, editing, onClose, onSaved }) {
  const { profile } = useAuth()
  const isEdit = !!editing
  const [name, setName] = useState(editing?.name || '')
  const [nameKana, setNameKana] = useState(editing?.nameKana || '')
  const [phone, setPhone] = useState(editing?.phone || '')
  const [birthday, setBirthday] = useState(() => {
    if (!editing?.birthday) return ''
    const d = editing.birthday.toDate ? editing.birthday.toDate() : new Date(editing.birthday)
    return d.toISOString().slice(0, 10)
  })
  const [gender, setGender] = useState(editing?.gender || 'F')
  const [skinType, setSkinType] = useState(editing?.skinType || [])
  const [concerns, setConcerns] = useState(editing?.concerns || [])
  const [skinNotes, setSkinNotes] = useState(editing?.skinNotes || '')
  const [memo, setMemo] = useState(editing?.memo || '')
  const [saving, setSaving] = useState(false)

  const toggle = (arr, setArr, val) => {
    setArr(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val])
  }

  const handleSave = async () => {
    if (!name.trim()) { alert('お名前は必須です'); return }
    // 二重防御：UI非表示を迂回されても保存前に権限チェック
    // 新規は canCreateCustomer（salonStaff もOK）、編集は canEditCustomer（salonStaff NG）
    try {
      assertCan(isEdit ? canEditCustomer : canCreateCustomer, profile)
    } catch (e) {
      alert(e.message); return
    }
    setSaving(true)
    try {
      const data = {
        salonCompanyName: companyName,
        name: name.trim(),
        nameKana: nameKana.trim(),
        phone: phone.trim(),
        gender,
        skinType,
        concerns,
        skinNotes,
        memo,
        birthday: birthday ? Timestamp.fromDate(new Date(birthday)) : null,
        updatedAt: serverTimestamp(),
      }
      if (isEdit) {
        await updateDoc(doc(db, 'customers', editing.id), data)
      } else {
        await addDoc(collection(db, 'customers'), {
          ...data,
          firstVisit: null,
          lastVisit: null,
          visitCount: 0,
          totalSpent: 0,
          tags: [],
          createdAt: serverTimestamp(),
        })
      }
      onSaved()
    } catch (e) {
      console.error(e)
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEdit) return
    // 二重防御：削除権限チェック
    try {
      assertCan(canDeleteCustomer, profile)
    } catch (e) {
      alert(e.message); return
    }
    if (!confirm(`「${editing.name}」を削除しますか？この操作は取り消せません。`)) return
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'customers', editing.id))
      onSaved()
    } catch (e) {
      alert('削除に失敗しました: ' + e.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{isEdit ? '顧客情報を編集' : '新規顧客を登録'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-gray-700">お名前 *</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">フリガナ</label>
              <input value={nameKana} onChange={(e) => setNameKana(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">電話番号</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">生年月日</label>
              <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">性別</label>
              <select value={gender} onChange={(e) => setGender(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="F">女性</option>
                <option value="M">男性</option>
                <option value="other">その他</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">肌タイプ（複数選択可）</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {SKIN_TYPE_OPTIONS.map((t) => (
                <button key={t} type="button"
                  onClick={() => toggle(skinType, setSkinType, t)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    skinType.includes(t)
                      ? 'bg-pink-600 text-white'
                      : 'border border-gray-300 bg-white text-gray-700'
                  }`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">お悩み（複数選択可）</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {CONCERN_OPTIONS.map((t) => (
                <button key={t} type="button"
                  onClick={() => toggle(concerns, setConcerns, t)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    concerns.includes(t)
                      ? 'bg-pink-600 text-white'
                      : 'border border-gray-300 bg-white text-gray-700'
                  }`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">肌状態メモ（自由記述）</label>
            <textarea value={skinNotes} onChange={(e) => setSkinNotes(e.target.value)}
              rows={3} placeholder="例：頬の乾燥が気になる、Tゾーン皮脂多め…"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">その他メモ</label>
            <textarea value={memo} onChange={(e) => setMemo(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <div>
            {isEdit && (
              <button onClick={handleDelete} disabled={saving}
                className="text-sm text-red-600 hover:underline">
                削除
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
              キャンセル
            </button>
            <button onClick={handleSave} disabled={saving}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================
// 顧客詳細パネル（来店履歴 + レコメンド統合）
// ============================
function CustomerDetail({ customer, onClose, onChanged }) {
  const { profile } = useAuth()
  const allowAddVisit = canAddVisit(profile)
  const allowEditVisit = canEditVisit(profile)
  const allowDeleteVisit = canDeleteVisit(profile)
  const [visits, setVisits] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showVisitForm, setShowVisitForm] = useState(false)
  const [editingVisit, setEditingVisit] = useState(null)
  const [deletingVisitId, setDeletingVisitId] = useState(null)

  const loadVisits = async () => {
    setLoading(true)
    try {
      const snap = await getDocs(
        query(
          collection(db, 'customers', customer.id, 'visits'),
          orderBy('visitDate', 'desc'),
        ),
      )
      setVisits(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const loadProducts = async () => {
    try {
      const snap = await getDocs(
        query(collection(db, 'salonProducts'), where('active', '==', true)),
      )
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('商品マスタ取得エラー:', e)
    }
  }

  useEffect(() => {
    loadVisits()
    loadProducts()
  }, [customer.id])

  // 来店編集・削除後に customer のサマリーを再計算して更新する。
  // delta 計算より全件再集計の方がズレが累積しないので単純で安全。
  const recomputeCustomerAggregates = async () => {
    try {
      const snap = await getDocs(
        collection(db, 'customers', customer.id, 'visits'),
      )
      let firstTs = null
      let lastTs = null
      let total = 0
      snap.docs.forEach((d) => {
        const data = d.data()
        const ts = data.visitDate
        if (ts) {
          if (!firstTs || ts.seconds < firstTs.seconds) firstTs = ts
          if (!lastTs || ts.seconds > lastTs.seconds) lastTs = ts
        }
        total += Number(data.totalAmount) || 0
      })
      await updateDoc(doc(db, 'customers', customer.id), {
        firstVisit: firstTs,
        lastVisit: lastTs,
        visitCount: snap.size,
        totalSpent: total,
        updatedAt: serverTimestamp(),
      })
    } catch (e) {
      // 集計失敗しても visit 自体の操作は既に成功しているので画面は更新する。
      // ただしログには残す。
      console.error('customer サマリー再計算失敗:', e)
    }
  }

  // 来店削除
  const handleDeleteVisit = async (visit) => {
    // 二重防御：UI 非表示を迂回されても保存前にチェック
    try {
      assertCan(canDeleteVisit, profile)
    } catch (e) {
      alert(e.message); return
    }
    const when = fmtDate(visit.visitDate)
    const amount = fmtYen(visit.totalAmount)
    if (!confirm(`${when} の来店記録（${amount}）を削除します。\nこの操作は取り消せません。\n\n本当に削除しますか？`)) return

    setDeletingVisitId(visit.id)
    try {
      await deleteDoc(doc(db, 'customers', customer.id, 'visits', visit.id))
      await recomputeCustomerAggregates()
      await loadVisits()
      onChanged && onChanged()
    } catch (e) {
      console.error('来店削除失敗:', e)
      alert('削除に失敗しました: ' + e.message)
    } finally {
      setDeletingVisitId(null)
    }
  }

  // レコメンドロジック
  const recommendations = useMemo(() => {
    if (!products.length) return []
    const skinTypes = customer.skinType || []
    const concerns = customer.concerns || []
    const usedProductIds = new Set(
      visits.flatMap((v) => (v.productsSold || []).map((p) => p.productId)),
    )

    return products
      .map((p) => {
        let score = 0
        const matchedSkin = (p.skinTypes || []).filter((s) => skinTypes.includes(s))
        const matchedConcerns = (p.concerns || []).filter((c) => concerns.includes(c))
        score += matchedSkin.length * 2
        score += matchedConcerns.length * 3
        // 既に購入済みなら優先度下げる（リピート提案には別の場所で対応）
        if (usedProductIds.has(p.id)) score -= 5
        return { ...p, score, matchedSkin, matchedConcerns, alreadyBought: usedProductIds.has(p.id) }
      })
      .filter((p) => p.score > 0 || p.matchedSkin.length || p.matchedConcerns.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
  }, [products, customer, visits])

  return (
    <div className="rounded-xl border-2 border-pink-300 bg-white p-6 shadow-md">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-pink-700">
          📋 {customer.name} 様 の詳細
        </h3>
        <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600">閉じる ✕</button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <h4 className="text-sm font-bold text-gray-700">基本情報</h4>
          <dl className="space-y-1 text-sm">
            <div className="flex">
              <dt className="w-24 text-gray-500">電話</dt>
              <dd>{customer.phone || '—'}</dd>
            </div>
            <div className="flex">
              <dt className="w-24 text-gray-500">生年月日</dt>
              <dd>{fmtDate(customer.birthday)}</dd>
            </div>
            <div className="flex">
              <dt className="w-24 text-gray-500">初回来店</dt>
              <dd>{fmtDate(customer.firstVisit)}</dd>
            </div>
            <div className="flex">
              <dt className="w-24 text-gray-500">最終来店</dt>
              <dd>{fmtDate(customer.lastVisit)}</dd>
            </div>
            <div className="flex">
              <dt className="w-24 text-gray-500">累計来店</dt>
              <dd>{customer.visitCount || 0}回</dd>
            </div>
            <div className="flex">
              <dt className="w-24 text-gray-500">累計売上</dt>
              <dd className="font-bold text-pink-700">{fmtYen(customer.totalSpent)}</dd>
            </div>
          </dl>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-bold text-gray-700">肌情報</h4>
          <div className="text-xs text-gray-500">肌タイプ</div>
          <div className="flex flex-wrap gap-1">
            {(customer.skinType || []).map((t) => (
              <span key={t} className="rounded-full bg-pink-100 px-2 py-0.5 text-xs text-pink-700">{t}</span>
            ))}
            {(!customer.skinType || customer.skinType.length === 0) && <span className="text-xs text-gray-400">未設定</span>}
          </div>
          <div className="text-xs text-gray-500 mt-2">お悩み</div>
          <div className="flex flex-wrap gap-1">
            {(customer.concerns || []).map((t) => (
              <span key={t} className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">{t}</span>
            ))}
            {(!customer.concerns || customer.concerns.length === 0) && <span className="text-xs text-gray-400">未設定</span>}
          </div>
        </div>
      </div>

      {customer.skinNotes && (
        <div className="mt-4 rounded-lg bg-gray-50 p-3">
          <div className="text-xs font-medium text-gray-500">肌状態メモ</div>
          <div className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{customer.skinNotes}</div>
        </div>
      )}

      {/* おすすめ商品（②レコメンド機能） */}
      <div className="mt-4 rounded-xl border-2 border-pink-200 bg-gradient-to-br from-pink-50 to-yellow-50 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-bold text-pink-700">💡 このお客様への店販おすすめ</div>
          <div className="text-[10px] text-pink-500">肌タイプ × お悩み × 商品マスタで自動算出</div>
        </div>
        {recommendations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-pink-300 p-3 text-center text-xs text-pink-600">
            {products.length === 0
              ? '商品マスタが未登録です。本社にお問い合わせください。'
              : '肌タイプ・お悩みを設定すると、おすすめ商品が表示されます。'}
          </div>
        ) : (
          <ul className="space-y-2">
            {recommendations.map((p) => (
              <li key={p.id} className="rounded-lg bg-white p-3 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-bold text-gray-900">{p.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.matchedSkin.map((s) => (
                        <span key={s} className="rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-pink-700">肌:{s}</span>
                      ))}
                      {p.matchedConcerns.map((c) => (
                        <span key={c} className="rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] text-yellow-700">悩:{c}</span>
                      ))}
                      {p.alreadyBought && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700">リピ提案</span>
                      )}
                    </div>
                  </div>
                  <div className="ml-3 text-right">
                    <div className="text-sm font-bold text-pink-700">{fmtYen(p.price)}</div>
                  </div>
                </div>
                {p.suggestedScript && (
                  <div className="mt-2 rounded-md bg-pink-50 p-2 text-xs text-gray-700">
                    💬 <span className="font-medium">提案セリフ：</span>
                    {p.suggestedScript.replace('{name}', customer.name)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 来店履歴 + 来店登録ボタン */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-gray-700">来店履歴</h4>
          {allowAddVisit && (
            <button
              onClick={() => setShowVisitForm(true)}
              className="rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-700"
            >
              + 来店を登録
            </button>
          )}
        </div>
        {loading ? (
          <div className="mt-2 text-sm text-gray-500">読み込み中…</div>
        ) : visits.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-gray-300 p-4 text-center text-xs text-gray-500">
            来店履歴はまだありません。「+ 来店を登録」から記録してください。
          </div>
        ) : (
          <ul className="mt-2 space-y-2">
            {visits.map((v) => (
              <li key={v.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="flex justify-between items-start gap-2">
                  <span className="font-medium">{fmtDate(v.visitDate)}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-pink-600 font-bold">{fmtYen(v.totalAmount)}</span>
                    {allowEditVisit && (
                      <button
                        onClick={() => { setEditingVisit(v); setShowVisitForm(true) }}
                        className="text-[10px] text-pink-600 hover:underline"
                      >
                        編集
                      </button>
                    )}
                    {allowDeleteVisit && (
                      <button
                        onClick={() => handleDeleteVisit(v)}
                        disabled={deletingVisitId === v.id}
                        className="text-[10px] text-red-500 hover:underline disabled:opacity-50"
                      >
                        {deletingVisitId === v.id ? '削除中…' : '削除'}
                      </button>
                    )}
                  </div>
                </div>
                {(v.menu || []).length > 0 && (
                  <div className="text-xs text-gray-600 mt-1">施術: {v.menu.join(', ')}</div>
                )}
                {(v.productsSold || []).length > 0 && (
                  <div className="text-xs text-pink-600 mt-1">
                    🛍 店販: {v.productsSold.map((p) => `${p.productName}×${p.quantity}`).join(', ')}
                  </div>
                )}
                {v.skinConditionNote && (
                  <div className="mt-1 rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">{v.skinConditionNote}</div>
                )}
                {v.nextRecommendation && (
                  <div className="mt-1 rounded bg-yellow-50 px-2 py-1 text-xs text-yellow-800">
                    次回提案: {v.nextRecommendation}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showVisitForm && (
        <VisitForm
          customer={customer}
          products={products}
          editing={editingVisit}
          onClose={() => { setShowVisitForm(false); setEditingVisit(null) }}
          onSaved={async () => {
            setShowVisitForm(false)
            setEditingVisit(null)
            await loadVisits()
            // 編集時はサマリー再計算（新規登録時は VisitForm 内で increment 済み）
            if (editingVisit) await recomputeCustomerAggregates()
            onChanged && onChanged()
          }}
        />
      )}
    </div>
  )
}

// ============================
// 来店登録フォーム（① コア機能）
// ============================
function VisitForm({ customer, products, editing, onClose, onSaved }) {
  const { profile } = useAuth()
  const isEdit = !!editing
  const today = new Date().toISOString().slice(0, 10)
  const initialDate = (() => {
    if (!editing?.visitDate) return today
    const d = editing.visitDate.toDate ? editing.visitDate.toDate() : new Date(editing.visitDate)
    return d.toISOString().slice(0, 10)
  })()
  const [visitDate, setVisitDate] = useState(initialDate)
  const [menu, setMenu] = useState((editing?.menu || []).join(', '))
  const [menuPrice, setMenuPrice] = useState(editing?.menuPrice ?? '')
  const [productsSold, setProductsSold] = useState(
    (editing?.productsSold || []).map((p) => ({
      productId: p.productId,
      productName: p.productName,
      quantity: p.quantity,
      price: p.price,
    })),
  )
  const [skinConditionNote, setSkinConditionNote] = useState(editing?.skinConditionNote || '')
  const [nextRecommendation, setNextRecommendation] = useState(editing?.nextRecommendation || '')
  const [saving, setSaving] = useState(false)

  const totalAmount = useMemo(() => {
    const m = Number(menuPrice) || 0
    const p = productsSold.reduce((sum, x) => sum + (Number(x.price) || 0) * (Number(x.quantity) || 0), 0)
    return m + p
  }, [menuPrice, productsSold])

  const addProduct = (productId) => {
    const p = products.find((x) => x.id === productId)
    if (!p) return
    if (productsSold.some((x) => x.productId === productId)) return
    setProductsSold([...productsSold, {
      productId: p.id,
      productName: p.name,
      quantity: 1,
      price: p.price || 0,
    }])
  }

  const updateProduct = (idx, field, value) => {
    const next = [...productsSold]
    next[idx] = { ...next[idx], [field]: value }
    setProductsSold(next)
  }

  const removeProduct = (idx) => {
    setProductsSold(productsSold.filter((_, i) => i !== idx))
  }

  const handleSave = async () => {
    if (!visitDate) { alert('来店日を入力してください'); return }
    // 二重防御：新規は canAddVisit、編集は canEditVisit
    try {
      assertCan(isEdit ? canEditVisit : canAddVisit, profile)
    } catch (e) {
      alert(e.message); return
    }
    setSaving(true)
    try {
      const visitTs = Timestamp.fromDate(new Date(visitDate))
      const menuArr = menu.split(/[,、，]/).map((s) => s.trim()).filter(Boolean)

      const visitData = {
        visitDate: visitTs,
        menu: menuArr,
        menuPrice: Number(menuPrice) || 0,
        productsUsed: editing?.productsUsed || [],
        productsSold: productsSold.map((p) => ({
          productId: p.productId,
          productName: p.productName,
          quantity: Number(p.quantity) || 0,
          price: Number(p.price) || 0,
        })),
        totalAmount,
        skinConditionNote,
        nextRecommendation,
      }

      if (isEdit) {
        // 編集：visit のみ更新。customer 側のサマリーは親コンポーネント側で
        //       recomputeCustomerAggregates() が再計算する。
        await updateDoc(
          doc(db, 'customers', customer.id, 'visits', editing.id),
          { ...visitData, updatedAt: serverTimestamp() },
        )
      } else {
        // 新規：visit 追加 + customer の visitCount/totalSpent/lastVisit を batch で一発更新
        const batch = writeBatch(db)
        const visitRef = doc(collection(db, 'customers', customer.id, 'visits'))
        batch.set(visitRef, { ...visitData, createdAt: serverTimestamp() })

        const customerRef = doc(db, 'customers', customer.id)
        const customerUpdate = {
          lastVisit: visitTs,
          visitCount: increment(1),
          totalSpent: increment(totalAmount),
          updatedAt: serverTimestamp(),
        }
        // firstVisit が未設定なら今回をセット
        if (!customer.firstVisit) {
          customerUpdate.firstVisit = visitTs
        }
        batch.update(customerRef, customerUpdate)

        await batch.commit()
      }
      onSaved()
    } catch (e) {
      console.error('来店保存失敗:', e)
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{isEdit ? '来店を編集' : '来店登録'} — {customer.name} 様</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-gray-700">来店日 *</label>
              <input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">施術料金</label>
              <input type="number" value={menuPrice} onChange={(e) => setMenuPrice(e.target.value)}
                placeholder="0"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">施術メニュー（カンマ区切り）</label>
            <input value={menu} onChange={(e) => setMenu(e.target.value)}
              placeholder="例: フェイシャル60分, 肩マッサージ"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>

          {/* 店販商品 */}
          <div>
            <label className="text-xs font-medium text-gray-700">店販商品（売れたもの）</label>
            {products.length === 0 ? (
              <div className="mt-1 rounded-lg border border-dashed border-gray-300 p-3 text-center text-xs text-gray-500">
                商品マスタが未登録のため店販記録はできません
              </div>
            ) : (
              <>
                <select
                  onChange={(e) => { if (e.target.value) { addProduct(e.target.value); e.target.value = '' } }}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">+ 商品を追加</option>
                  {products
                    .filter((p) => !productsSold.some((s) => s.productId === p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({fmtYen(p.price)})</option>
                    ))}
                </select>
                {productsSold.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {productsSold.map((p, i) => (
                      <div key={p.productId} className="flex items-center gap-2 rounded-lg border border-gray-200 p-2 text-sm">
                        <div className="flex-1">{p.productName}</div>
                        <input type="number" value={p.quantity}
                          onChange={(e) => updateProduct(i, 'quantity', e.target.value)}
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-xs" />
                        <span className="text-xs text-gray-500">×</span>
                        <input type="number" value={p.price}
                          onChange={(e) => updateProduct(i, 'price', e.target.value)}
                          className="w-24 rounded border border-gray-300 px-2 py-1 text-xs" />
                        <button onClick={() => removeProduct(i)} className="text-red-500 hover:text-red-700">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rounded-lg bg-pink-50 p-3 text-right">
            <span className="text-xs text-pink-700">合計売上</span>
            <span className="ml-2 text-xl font-bold text-pink-700">{fmtYen(totalAmount)}</span>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">本日の肌状態メモ</label>
            <textarea value={skinConditionNote} onChange={(e) => setSkinConditionNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">次回提案メモ</label>
            <textarea value={nextRecommendation} onChange={(e) => setNextRecommendation(e.target.value)}
              rows={2} placeholder="例: 次回ボンバークリームを試していただく"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving}
            className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50">
            {saving ? '保存中…' : (isEdit ? '変更を保存' : '来店を保存')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================
// CSV インポート（④ コア機能）
// ============================
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { headers: [], rows: [] }
  const parseRow = (line) => {
    const result = []
    let current = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
        else if (ch === '"') inQuote = false
        else current += ch
      } else {
        if (ch === '"') inQuote = true
        else if (ch === ',') { result.push(current); current = '' }
        else current += ch
      }
    }
    result.push(current)
    return result
  }
  const headers = parseRow(lines[0]).map((h) => h.trim())
  const rows = lines.slice(1).map(parseRow)
  return { headers, rows }
}

function CsvImportModal({ companyName, onClose, onDone }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: [] })

  const handleFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const text = ev.target.result
        const { headers, rows } = parseCsv(text)
        setPreview({ headers, rows: rows.slice(0, 5), totalRows: rows.length, allRows: rows })
      } catch (err) {
        alert('CSV解析失敗: ' + err.message)
      }
    }
    reader.readAsText(f, 'UTF-8')
  }

  const buildCustomer = (headers, row) => {
    const get = (key) => {
      const idx = headers.findIndex((h) => h === key)
      return idx >= 0 ? (row[idx] || '').trim() : ''
    }
    const name = get('name') || get('お名前') || get('氏名')
    if (!name) return null
    const birthday = get('birthday') || get('生年月日')
    const skinType = (get('skinType') || get('肌タイプ')).split(/[,、|]/).map((s) => s.trim()).filter(Boolean)
    const concerns = (get('concerns') || get('お悩み')).split(/[,、|]/).map((s) => s.trim()).filter(Boolean)
    return {
      salonCompanyName: companyName,
      name,
      nameKana: get('nameKana') || get('フリガナ'),
      phone: get('phone') || get('電話番号') || get('TEL'),
      gender: get('gender') || get('性別') || 'F',
      birthday: birthday ? Timestamp.fromDate(new Date(birthday)) : null,
      skinType,
      concerns,
      skinNotes: get('skinNotes') || get('肌状態メモ') || get('メモ'),
      memo: get('memo') || get('備考'),
      tags: [],
      firstVisit: null,
      lastVisit: null,
      visitCount: 0,
      totalSpent: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
  }

  const handleImport = async () => {
    if (!preview) return
    const { headers, allRows } = preview
    setImporting(true)
    setProgress({ done: 0, total: allRows.length, errors: [] })

    let done = 0
    const errors = []
    // 500件ずつバッチ書き込み
    for (let i = 0; i < allRows.length; i += 400) {
      const chunk = allRows.slice(i, i + 400)
      const batch = writeBatch(db)
      let added = 0
      chunk.forEach((row, idx) => {
        try {
          const data = buildCustomer(headers, row)
          if (!data) {
            errors.push(`行${i + idx + 2}: 名前なしスキップ`)
            return
          }
          const ref = doc(collection(db, 'customers'))
          batch.set(ref, data)
          added++
        } catch (e) {
          errors.push(`行${i + idx + 2}: ${e.message}`)
        }
      })
      try {
        await batch.commit()
        done += added
        setProgress({ done, total: allRows.length, errors: [...errors] })
      } catch (e) {
        errors.push(`バッチ${Math.floor(i / 400) + 1}: ${e.message}`)
        setProgress({ done, total: allRows.length, errors: [...errors] })
      }
    }
    setImporting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">📥 顧客台帳 CSV インポート</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
            <div className="font-bold">対応する見出し（1行目）</div>
            <div className="mt-1">
              <code>name</code> または <code>お名前</code> / <code>氏名</code>（必須）<br/>
              <code>nameKana</code> / <code>フリガナ</code>、<code>phone</code> / <code>電話番号</code>、<code>birthday</code> / <code>生年月日</code><br/>
              <code>skinType</code> / <code>肌タイプ</code>（カンマ区切り）、<code>concerns</code> / <code>お悩み</code><br/>
              <code>skinNotes</code> / <code>肌状態メモ</code>、<code>memo</code> / <code>備考</code>
            </div>
          </div>

          <div>
            <input type="file" accept=".csv" onChange={handleFile}
              className="block w-full text-sm" />
          </div>

          {preview && (
            <div className="rounded-lg border border-gray-200 p-3">
              <div className="text-sm font-medium text-gray-700">
                プレビュー（最初の5行 / 合計 {preview.totalRows} 行）
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      {preview.headers.map((h, i) => (
                        <th key={i} className="px-2 py-1 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className="border-t">
                        {r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {progress.total > 0 && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              進捗: {progress.done} / {progress.total} 件登録
              {progress.errors.length > 0 && (
                <div className="mt-2 text-xs text-red-600">
                  <div>エラー {progress.errors.length} 件:</div>
                  <ul className="mt-1 list-disc list-inside">
                    {progress.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={importing}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
            {progress.done > 0 ? '閉じる' : 'キャンセル'}
          </button>
          {progress.done > 0 && !importing && (
            <button onClick={onDone}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700">
              一覧を更新
            </button>
          )}
          <button onClick={handleImport} disabled={!preview || importing}
            className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50">
            {importing ? `取込中… (${progress.done}/${progress.total})` : `${preview?.totalRows || 0}件を取込`}
          </button>
        </div>
      </div>
    </div>
  )
}
