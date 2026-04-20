/**
 * ERP 受注画面（Phase 1 Step 2）
 *
 * 機能:
 *   - 一覧表示（company でフィルタ、orderStatus で色分け）
 *   - 新規作成（モーダル、items 複数行、total 自動計算）
 *   - 詳細ドロワー（items 表示、ステータス遷移ボタン、承認ボタン）
 *
 * 設計準拠:
 *   - docs/04_ERP_DATA_MODEL.md v0.5
 *   - writeBatch で Order + AuditLog を原子的に保存
 *   - ステータス遷移は statusMachine.assertTransition で検証
 *   - 権限は permissions.canXxxOrder を使用、assertCan で二重防御
 *
 * 重要な設計注記（ChatGPT レビュー反映 2026-04-18）:
 *   - orderCode は「表示用番号」。一意識別子は Firestore docId（Order.id）を使う。
 *     Step 5 で連番カウンタに差し替え予定まで、timestamp ベース採番は重複しうる前提で扱う。
 *   - version は監査・将来拡張用のフィールドで、まだ compare-and-swap（楽観ロック）は
 *     実装していない。Phase 2 で Firestore transaction ベースに切り替える。
 *   - company 境界：create 時は currentCompany を強制セット、update 時は変更不可。
 *     Firestore rules で boundary を強制するのは Step 3 で追加予定。
 *   - AuditLog の before/after は auditLog.addAuditToBatch 内で AUDITABLE_FIELDS に
 *     ホワイトリスト絞り込みされる（items は要約化）。呼び出し側で全量を渡しても OK。
 *   - 編集可能なステータスは draft のみ。confirmed 以降は ステータス遷移経由のみ。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  where,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useCompany } from '../contexts/CompanyContext.jsx'
import {
  canCreateOrder,
  canApproveOrder,
  canCancelOrder,
  assertCan,
} from '../lib/permissions.js'
import { ERP_COLLECTIONS } from '../lib/erp/collections.js'
import { validateOrder } from '../lib/erp/schema.js'
import {
  ORDER_STATUS,
  assertTransition,
  getNextStates,
} from '../lib/erp/statusMachine.js'
import { addAuditToBatch, buildRetryBlockedMessage } from '../lib/erp/auditLog.js'

const STATUS_LABEL = {
  draft: '下書き',
  confirmed: '確定',
  partially_allocated: '一部引当',
  fully_allocated: '引当済',
  partially_shipped: '一部出荷',
  shipped: '出荷済',
  completed: '完了',
  returned: '返品',
  cancelled: '取消',
}

const STATUS_COLOR = {
  draft: 'bg-gray-100 text-gray-700',
  confirmed: 'bg-indigo-100 text-indigo-800',
  partially_allocated: 'bg-blue-100 text-blue-800',
  fully_allocated: 'bg-blue-100 text-blue-900',
  partially_shipped: 'bg-amber-100 text-amber-800',
  shipped: 'bg-emerald-100 text-emerald-800',
  completed: 'bg-emerald-200 text-emerald-900',
  returned: 'bg-red-100 text-red-800',
  cancelled: 'bg-red-100 text-red-700',
}

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`
const fmtDate = (ts) => {
  if (!ts) return '-'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function StatusChip({ status }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLOR[status] || 'bg-gray-100'}`}>
      {STATUS_LABEL[status] || status}
    </span>
  )
}

export default function ErpOrders() {
  const { profile } = useAuth()
  const { company } = useCompany()

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')

  const loadOrders = async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = query(
        collection(db, ERP_COLLECTIONS.Order),
        where('company', '==', company.key),
        orderBy('orderDate', 'desc'),
      )
      const snap = await getDocs(q)
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadOrders() }, [company.key])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return orders
    return orders.filter((o) => o.orderStatus === statusFilter)
  }, [orders, statusFilter])

  const selected = orders.find((o) => o.id === selectedId)
  const allowCreate = canCreateOrder(profile)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">受注（ERP）</h1>
          <p className="text-xs text-gray-500">
            {company.name}（{company.key}）— {filtered.length} 件 / 全 {orders.length} 件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadOrders}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            🔄 再取得
          </button>
          {allowCreate ? (
            <button
              onClick={() => setShowForm(true)}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              + 新規受注
            </button>
          ) : (
            <button
              onClick={() => alert('この画面は閲覧権限のみです。受注作成には管理者権限が必要です。')}
              className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-500"
            >
              🔒 閲覧のみ
            </button>
          )}
        </div>
      </div>

      {/* ステータスフィルタ */}
      <div className="flex flex-wrap gap-2">
        {[
          ['all', `すべて`],
          ['draft', STATUS_LABEL.draft],
          ['confirmed', STATUS_LABEL.confirmed],
          ['shipped', STATUS_LABEL.shipped],
          ['completed', STATUS_LABEL.completed],
          ['cancelled', STATUS_LABEL.cancelled],
        ].map(([v, l]) => {
          const count = v === 'all' ? orders.length : orders.filter((o) => o.orderStatus === v).length
          return (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                statusFilter === v
                  ? 'bg-indigo-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {l} <span className="ml-1 opacity-80">({count})</span>
            </button>
          )
        })}
      </div>

      {err && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{err}</div>
      )}

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          受注データがまだありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">受注番号</th>
                  <th className="px-3 py-2 text-left">受注日</th>
                  <th className="px-3 py-2 text-left">得意先</th>
                  <th className="px-3 py-2 text-right">件数</th>
                  <th className="px-3 py-2 text-right">税込</th>
                  <th className="px-3 py-2 text-center">状態</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((o) => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">{o.orderCode}</td>
                    <td className="px-3 py-2">{fmtDate(o.orderDate)}</td>
                    <td className="px-3 py-2">{o.clientId}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{o.items?.length || 0}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtYen(o.total)}</td>
                    <td className="px-3 py-2 text-center"><StatusChip status={o.orderStatus} /></td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setSelectedId(o.id)}
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        詳細 →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 新規作成モーダル */}
      {showForm && (
        <OrderForm
          profile={profile}
          company={company}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadOrders() }}
        />
      )}

      {/* 詳細ドロワー */}
      {selected && (
        <OrderDetail
          order={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onChanged={() => loadOrders()}
        />
      )}
    </div>
  )
}

// ================================================================
// 新規作成モーダル
// ================================================================
function OrderForm({ profile, company, onClose, onSaved }) {
  const [clientId, setClientId] = useState('')
  const [customerType, setCustomerType] = useState('direct')
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10))
  const [requestedDate, setRequestedDate] = useState('')
  const [items, setItems] = useState([
    { productId: '', productName: '', qty: 1, unitPrice: 0 },
  ])
  const [saving, setSaving] = useState(false)

  // モーダル保存中はクローズ禁止（backdrop / Esc / 二重送信防止）
  // ChatGPT レビュー指摘 #7：保存完了/失敗までボタン状態を固定する
  useEffect(() => {
    if (!saving) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [saving])
  const handleBackdropClose = () => { if (!saving) onClose() }

  const addRow = () => setItems([...items, { productId: '', productName: '', qty: 1, unitPrice: 0 }])
  const removeRow = (i) => setItems(items.filter((_, idx) => idx !== i))
  const updateRow = (i, key, val) => {
    setItems(items.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)))
  }

  const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0)
  const tax = Math.floor(subtotal * 0.1)
  const total = subtotal + tax

  const handleSave = async () => {
    if (saving) return // 二重送信防止

    // (1) 権限チェック（UI非活性は補助、保存ロジック側で必ず再チェック）
    try {
      assertCan(canCreateOrder, profile, { userMessage: '受注作成権限がありません' })
    } catch (e) { alert(e.message); return }

    // (2) 入力バリデーション（空文字禁止・trim・正数必須）
    const cleanClientId = clientId.trim()
    if (!cleanClientId) { alert('得意先IDは必須です'); return }
    // 簡易形式チェック（英数字・ハイフン・アンダースコアのみ、2文字以上）
    if (!/^[A-Za-z0-9_-]{2,}$/.test(cleanClientId)) {
      alert('得意先IDは英数字・ハイフン・アンダースコアのみ、2文字以上で入力してください')
      return
    }
    if (!orderDate) { alert('受注日は必須です'); return }

    const cleanItems = items.map((it, idx) => ({
      lineNo: idx + 1,
      productId: (it.productId || '').trim(),
      productName: (it.productName || '').trim(),
      qty: Number(it.qty) || 0,
      unitPrice: Number(it.unitPrice) || 0,
      amount: (Number(it.qty) || 0) * (Number(it.unitPrice) || 0),
      allocatedQty: 0,
      shippedQty: 0,
    }))
    // バリデーション：各行ごと
    for (const it of cleanItems) {
      // 空行は後でフィルタするので無視（全部空ならエラー）
      if (!it.productId && !it.productName && it.qty === 0) continue
      if (!it.productId) { alert(`明細${it.lineNo}：商品IDが必須です`); return }
      if (!/^[A-Za-z0-9_-]{1,}$/.test(it.productId)) {
        alert(`明細${it.lineNo}：商品IDは英数字・ハイフン・アンダースコアのみ`)
        return
      }
      if (!it.productName) { alert(`明細${it.lineNo}：商品名が必須です`); return }
      if (!(it.qty > 0)) { alert(`明細${it.lineNo}：数量は正の数が必須`); return }
      if (it.unitPrice < 0) { alert(`明細${it.lineNo}：単価は 0 以上`); return }
    }
    const validItems = cleanItems.filter((it) => it.productId && it.productName && it.qty > 0)
    if (validItems.length === 0) { alert('明細を1行以上入力してください'); return }

    setSaving(true)
    try {
      // orderCode は「表示用番号」。一意識別子は Firestore docId（Order.id）。
      // Step 5 で連番カウンタに差し替え予定まで、timestamp ベース採番は重複しうる。
      // 一意性に依存した検索や update は docId で行うこと。
      const now = new Date()
      const orderCode = `O-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getTime() % 100000).padStart(5, '0')}`

      const orderData = {
        orderCode,
        projectId: null,
        quotationId: null,
        clientId: cleanClientId,
        customerType,
        orderDate: Timestamp.fromDate(new Date(orderDate)),
        requestedDeliveryDate: requestedDate ? Timestamp.fromDate(new Date(requestedDate)) : null,
        items: validItems,
        subtotal,
        tax,
        total,
        externalSource: null,
        externalOrderId: null,
        externalSyncedAt: null,
        externalRawId: null,
        externalMeta: null,
        orderStatus: ORDER_STATUS.DRAFT,
        shipmentStatus: 'pending',
        billingStatus: 'pending',
        approvedAt: null,
        approvedBy: null,
        deletedAt: null,
        deletedBy: null,
        // company は current company を強制セット。rt/rc の write-side 境界。
        // update 時にはこのフィールドは絶対に変更しない（doTransition で除外済み）。
        company: company.key,
        // version: 監査・将来拡張用。まだ compare-and-swap（楽観ロック）は未実装。
        // Phase 2 で Firestore transaction 化予定。現状は「更新のたびに +1」するだけ。
        version: 1,
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        updatedAt: serverTimestamp(),
        updatedBy: profile.uid,
      }

      // (3) スキーマ事前検証（lib/erp/schema.js、共通ルール＋Order固有）
      validateOrder(orderData, { isCreate: true })

      // writeBatch で Order + AuditLog を原子的に書き込み
      const batch = writeBatch(db)
      const orderRef = doc(collection(db, ERP_COLLECTIONS.Order))
      batch.set(orderRef, orderData)
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.Order,
        docId: orderRef.id,
        action: 'create',
        before: null,
        after: orderData,
        profile,
      })
      await batch.commit()
      onSaved()
    } catch (e) {
      console.error(e)
      alert(buildRetryBlockedMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleBackdropClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">新規受注</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >✕</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-gray-700">得意先ID *</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="例: BC-0001（bp_clients のID）"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">顧客種別</label>
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="direct">直販</option>
              <option value="dealer">代理店</option>
              <option value="salon">サロン</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">受注日 *</label>
            <input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">希望納期</label>
            <input
              type="date"
              value={requestedDate}
              onChange={(e) => setRequestedDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-gray-700">明細</label>
            <button onClick={addRow} className="text-xs text-indigo-600 hover:underline">+ 行を追加</button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-2 py-1.5 text-left">商品ID</th>
                  <th className="px-2 py-1.5 text-left">商品名</th>
                  <th className="px-2 py-1.5 text-right">数量</th>
                  <th className="px-2 py-1.5 text-right">単価</th>
                  <th className="px-2 py-1.5 text-right">小計</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2 py-1">
                      <input
                        value={r.productId}
                        onChange={(e) => updateRow(i, 'productId', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                        placeholder="SKU"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        value={r.productName}
                        onChange={(e) => updateRow(i, 'productName', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min="0"
                        value={r.qty}
                        onChange={(e) => updateRow(i, 'qty', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min="0"
                        value={r.unitPrice}
                        onChange={(e) => updateRow(i, 'unitPrice', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-1 text-right text-xs">{fmtYen((Number(r.qty) || 0) * (Number(r.unitPrice) || 0))}</td>
                    <td className="px-1 py-1 text-center">
                      {items.length > 1 && (
                        <button onClick={() => removeRow(i)} className="text-xs text-red-500 hover:underline">×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-6 text-sm">
          <div>小計：<span className="font-medium">{fmtYen(subtotal)}</span></div>
          <div>税：<span className="font-medium">{fmtYen(tax)}</span></div>
          <div className="text-base font-bold">税込：{fmtYen(total)}</div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存（下書き）'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// 詳細ドロワー（ステータス遷移・承認）
// ================================================================
function OrderDetail({ order, profile, onClose, onChanged }) {
  const [busy, setBusy] = useState(false)
  const nextStates = getNextStates('order', order.orderStatus)

  const allowApprove = canApproveOrder(profile)
  const allowCancel = canCancelOrder(profile)

  const doTransition = async (to, { isApprove = false, isCancel = false } = {}) => {
    if (busy) return // 二重送信防止

    // (1) 権限チェック：UI の disabled は補助。保存ロジック側で必ず再判定する。
    //     batch を作る前に行うことで、権限不足時には Firestore を1回も叩かない。
    if (isApprove) {
      try { assertCan(canApproveOrder, profile, { userMessage: '承認権限がありません' }) }
      catch (e) { alert(e.message); return }
    }
    if (isCancel) {
      try { assertCan(canCancelOrder, profile, { userMessage: '取消権限がありません' }) }
      catch (e) { alert(e.message); return }
    }

    // (2) ステータス遷移可能性の検証（statusMachine）
    try {
      assertTransition('order', order.orderStatus, to)
    } catch (e) { alert(e.message); return }

    // (3) 破壊的操作の理由必須（cancel 時）
    let reason = null
    if (to === ORDER_STATUS.CANCELLED) {
      reason = window.prompt('取消理由を入力してください（必須）')
      if (!reason || !reason.trim()) { alert('理由は必須です'); return }
    }

    setBusy(true)
    try {
      // (4) batch 直前に再度権限チェック（最後の砦、ロジック二重化）
      if (isApprove) assertCan(canApproveOrder, profile, { userMessage: '承認権限がありません' })
      if (isCancel) assertCan(canCancelOrder, profile, { userMessage: '取消権限がありません' })

      const batch = writeBatch(db)
      const orderRef = doc(db, ERP_COLLECTIONS.Order, order.id)
      const now = serverTimestamp()

      // company は update で触らない（write-side boundary）
      const afterPartial = {
        orderStatus: to,
        updatedAt: now,
        updatedBy: profile.uid,
        // version: 監査・将来拡張用。楽観ロックは未実装なので race condition の保護にはならない。
        version: (order.version || 1) + 1,
      }
      if (isApprove) {
        // 承認の必須記録：approvedAt / approvedBy（承認前 version は AuditLog.before.version で保持）
        afterPartial.approvedAt = now
        afterPartial.approvedBy = profile.uid
      }
      batch.update(orderRef, afterPartial)

      // AuditLog: action と reason、承認前後の version を保持
      // before/after は auditLog.addAuditToBatch 内で AUDITABLE_FIELDS に絞り込まれる
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.Order,
        docId: order.id,
        action: isCancel ? 'cancel' : 'status_change',
        before: {
          orderStatus: order.orderStatus,
          version: order.version || 1,
          approvedAt: order.approvedAt || null,
          approvedBy: order.approvedBy || null,
        },
        after: {
          orderStatus: to,
          version: (order.version || 1) + 1,
          approvedAt: isApprove ? now : (order.approvedAt || null),
          approvedBy: isApprove ? profile.uid : (order.approvedBy || null),
        },
        profile,
        reason,
      })

      await batch.commit()
      onChanged()
      onClose()
    } catch (e) {
      console.error(e)
      alert(buildRetryBlockedMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // busy 中は backdrop click / Esc 無効化（保存中クローズ禁止）
  useEffect(() => {
    if (!busy) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [busy])
  const handleBackdropClose = () => { if (!busy) onClose() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleBackdropClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{order.orderCode}</h2>
            <div className="mt-1 flex items-center gap-2">
              <StatusChip status={order.orderStatus} />
              <span className="text-xs text-gray-500">v{order.version || 1}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-gray-500 text-xs">得意先：</span>{order.clientId}</div>
          <div><span className="text-gray-500 text-xs">種別：</span>{order.customerType}</div>
          <div><span className="text-gray-500 text-xs">受注日：</span>{fmtDate(order.orderDate)}</div>
          <div><span className="text-gray-500 text-xs">希望納期：</span>{fmtDate(order.requestedDeliveryDate)}</div>
          <div className="col-span-2"><span className="text-gray-500 text-xs">承認：</span>{order.approvedAt ? fmtDate(order.approvedAt) : '未承認'}</div>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-gray-700">明細</div>
          <table className="w-full rounded border border-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-2 py-1 text-left">商品</th>
                <th className="px-2 py-1 text-right">数量</th>
                <th className="px-2 py-1 text-right">単価</th>
                <th className="px-2 py-1 text-right">小計</th>
              </tr>
            </thead>
            <tbody>
              {(order.items || []).map((it) => (
                <tr key={it.lineNo} className="border-t border-gray-100">
                  <td className="px-2 py-1">
                    <div className="font-medium">{it.productName}</div>
                    <div className="text-[10px] text-gray-400">{it.productId}</div>
                  </td>
                  <td className="px-2 py-1 text-right">{it.qty}</td>
                  <td className="px-2 py-1 text-right">{fmtYen(it.unitPrice)}</td>
                  <td className="px-2 py-1 text-right">{fmtYen(it.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 text-xs">
              <tr><td colSpan="3" className="px-2 py-1 text-right">小計</td><td className="px-2 py-1 text-right">{fmtYen(order.subtotal)}</td></tr>
              <tr><td colSpan="3" className="px-2 py-1 text-right">税</td><td className="px-2 py-1 text-right">{fmtYen(order.tax)}</td></tr>
              <tr><td colSpan="3" className="px-2 py-1 text-right font-bold">税込</td><td className="px-2 py-1 text-right font-bold">{fmtYen(order.total)}</td></tr>
            </tfoot>
          </table>
        </div>

        {/* 操作ボタン */}
        <div className="mt-6 space-y-2">
          <div className="text-xs font-medium text-gray-700">ステータス操作</div>
          <div className="flex flex-wrap gap-2">
            {nextStates.length === 0 && (
              <span className="text-xs text-gray-400">この状態からの遷移はありません</span>
            )}
            {nextStates.map((next) => {
              const isApprove = order.orderStatus === ORDER_STATUS.DRAFT && next === ORDER_STATUS.CONFIRMED
              const isCancel = next === ORDER_STATUS.CANCELLED
              const needsPermission = (isApprove && !allowApprove) || (isCancel && !allowCancel)
              const label = isApprove
                ? '✅ 承認（draft → confirmed）'
                : isCancel
                  ? '❌ 取消'
                  : `→ ${STATUS_LABEL[next] || next}`
              return (
                <button
                  key={next}
                  disabled={busy || needsPermission}
                  onClick={() => doTransition(next, { isApprove, isCancel })}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    isCancel
                      ? 'border border-red-300 bg-white text-red-700 hover:bg-red-50'
                      : isApprove
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  } disabled:opacity-50`}
                  title={needsPermission ? '権限がありません' : ''}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
