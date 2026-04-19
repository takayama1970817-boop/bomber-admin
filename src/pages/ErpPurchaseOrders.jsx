/**
 * ERP 発注画面（Phase 1 Step 3）
 *
 * 機能:
 *   - 一覧表示（company でフィルタ、purchaseStatus で色分け）
 *   - 新規作成（親 Order を選択 → items から分割ピック → 仕入先・単価指定）
 *   - 詳細ドロワー（items 表示・ステータス遷移・承認・取消）
 *
 * 重要な設計注記（Step 2 から引き継ぎ）:
 *   - poCode は「表示用番号」。一意識別子は Firestore docId（PO.id）を使う。
 *     Step 5 で連番カウンタに差し替え予定まで、timestamp ベース採番は重複しうる。
 *   - version は監査・将来拡張用。まだ compare-and-swap（楽観ロック）は未実装。
 *     Phase 2 で Firestore transaction ベースに切り替える。
 *   - company 境界：create 時に currentCompany を強制セット、update 時は変更不可。
 *   - AuditLog は addAuditToBatch 内で AUDITABLE_FIELDS に自動絞込、items は要約化。
 *   - 編集可能なステータスは draft のみ。それ以外はステータス遷移経由のみ。
 *
 * Step 3 固有の設計:
 *   - 1 Order → N PurchaseOrder を自然に表現:
 *       PO は orderId で親 Order を参照。items は orderItemLineNo で親 item を参照。
 *       Order.items.allocatedQty の自動更新は Phase 2 で Cloud Functions 化。
 *       Phase 1 では手動で「どこまで発注済みか」の把握は PO 側から集計する方針。
 *   - 発注確定の status 遷移は Order から完全独立（PurchaseStatus machine）。
 *       Order の orderStatus は PO 側からは触らない（責務分離）。
 *   - supplier ロール未使用:
 *       supplier 操作（送信・受領）は admin/internal が代行。supplierId は手入力。
 *       将来 supplier ロールが追加されても、データ構造は互換。
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useCompany } from '../contexts/CompanyContext.jsx'
import {
  canCreatePurchaseOrder,
  canApprovePurchaseOrder,
  canSendPurchaseOrder,
  canCancelPurchaseOrder,
  assertCan,
} from '../lib/permissions.js'
import { ERP_COLLECTIONS } from '../lib/erp/collections.js'
import { validatePurchaseOrder } from '../lib/erp/schema.js'
import {
  PURCHASE_STATUS,
  assertTransition,
  getNextStates,
} from '../lib/erp/statusMachine.js'
import { addAuditToBatch, buildRetryBlockedMessage } from '../lib/erp/auditLog.js'

const STATUS_LABEL = {
  draft: '下書き',
  approved: '承認済',
  sent: '送信済',
  accepted: '承諾',
  in_production: '製造中',
  partially_received: '一部入庫',
  received: '入庫済',
  closed: '完了',
  rejected: '拒否',
  cancelled: '取消',
}

const STATUS_COLOR = {
  draft: 'bg-gray-100 text-gray-700',
  approved: 'bg-indigo-100 text-indigo-800',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-cyan-100 text-cyan-800',
  in_production: 'bg-purple-100 text-purple-800',
  partially_received: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-emerald-200 text-emerald-900',
  rejected: 'bg-red-100 text-red-800',
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

export default function ErpPurchaseOrders() {
  const { profile } = useAuth()
  const { company } = useCompany()

  const [pos, setPos] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')

  const loadPos = async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = query(
        collection(db, ERP_COLLECTIONS.PurchaseOrder),
        where('company', '==', company.key),
        orderBy('createdAt', 'desc'),
      )
      const snap = await getDocs(q)
      setPos(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadPos() }, [company.key])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return pos
    return pos.filter((p) => p.purchaseStatus === statusFilter)
  }, [pos, statusFilter])

  const selected = pos.find((p) => p.id === selectedId)
  const allowCreate = canCreatePurchaseOrder(profile)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">発注（ERP）</h1>
          <p className="text-xs text-gray-500">
            {company.name}（{company.key}）— {filtered.length} 件 / 全 {pos.length} 件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadPos}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          >
            🔄 再取得
          </button>
          {allowCreate ? (
            <button
              onClick={() => setShowForm(true)}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              + 新規発注
            </button>
          ) : (
            <button
              onClick={() => alert('この画面は閲覧権限のみです。発注作成には管理者権限が必要です。')}
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
          ['all', 'すべて'],
          ['draft', STATUS_LABEL.draft],
          ['approved', STATUS_LABEL.approved],
          ['sent', STATUS_LABEL.sent],
          ['received', STATUS_LABEL.received],
          ['closed', STATUS_LABEL.closed],
          ['cancelled', STATUS_LABEL.cancelled],
        ].map(([v, l]) => {
          const count = v === 'all' ? pos.length : pos.filter((p) => p.purchaseStatus === v).length
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
          発注データがまだありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">発注番号</th>
                  <th className="px-3 py-2 text-left">親受注</th>
                  <th className="px-3 py-2 text-left">仕入先</th>
                  <th className="px-3 py-2 text-right">件数</th>
                  <th className="px-3 py-2 text-right">税込</th>
                  <th className="px-3 py-2 text-center">状態</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">{p.poCode}</td>
                    <td className="px-3 py-2">
                      <Link
                        to="/admin/erp/orders"
                        className="font-mono text-xs text-indigo-600 hover:underline"
                      >
                        {p.orderCodeSnapshot || p.orderId?.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{p.supplierId}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{p.items?.length || 0}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtYen(p.total)}</td>
                    <td className="px-3 py-2 text-center"><StatusChip status={p.purchaseStatus} /></td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setSelectedId(p.id)}
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
        <PurchaseOrderForm
          profile={profile}
          company={company}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadPos() }}
        />
      )}

      {/* 詳細ドロワー */}
      {selected && (
        <PurchaseOrderDetail
          po={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onChanged={() => loadPos()}
        />
      )}
    </div>
  )
}

// ================================================================
// 新規作成モーダル
// ================================================================
function PurchaseOrderForm({ profile, company, onClose, onSaved }) {
  const [orders, setOrders] = useState([])
  const [orderLoading, setOrderLoading] = useState(true)
  const [selectedOrderId, setSelectedOrderId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  // items: { pick: bool, lineNo, productId, productName, qty, unitCost, maxQty }
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)

  // 親 Order 候補（最新の confirmed / partially_allocated / fully_allocated のみ）
  useEffect(() => {
    ;(async () => {
      try {
        const q = query(
          collection(db, ERP_COLLECTIONS.Order),
          where('company', '==', company.key),
          orderBy('orderDate', 'desc'),
          limit(50),
        )
        const snap = await getDocs(q)
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          // 発注可能な状態のみ（draft は確定前、cancelled 以降は対象外）
          .filter((o) => ['confirmed', 'partially_allocated', 'fully_allocated'].includes(o.orderStatus))
        setOrders(list)
      } catch (e) {
        console.error(e)
      } finally {
        setOrderLoading(false)
      }
    })()
  }, [company.key])

  // Order 選択時に items をピック候補として展開（残数 = qty - allocatedQty）
  useEffect(() => {
    if (!selectedOrderId) { setItems([]); return }
    const o = orders.find((x) => x.id === selectedOrderId)
    if (!o) { setItems([]); return }
    setItems((o.items || []).map((it) => {
      const maxQty = Math.max(0, (it.qty || 0) - (it.allocatedQty || 0))
      return {
        pick: false,
        lineNo: it.lineNo,
        orderItemLineNo: it.lineNo,
        productId: it.productId,
        productName: it.productName,
        qty: maxQty,
        unitCost: 0,
        maxQty,
      }
    }))
  }, [selectedOrderId, orders])

  // モーダル保存中クローズ禁止（backdrop / Esc）
  useEffect(() => {
    if (!saving) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [saving])
  const handleBackdropClose = () => { if (!saving) onClose() }

  const updateItem = (i, key, val) => {
    setItems(items.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)))
  }
  const togglePick = (i) => {
    setItems(items.map((r, idx) => (idx === i ? { ...r, pick: !r.pick } : r)))
  }

  const picked = items.filter((it) => it.pick)
  const subtotal = picked.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitCost) || 0), 0)
  const tax = Math.floor(subtotal * 0.1)
  const total = subtotal + tax

  const handleSave = async () => {
    if (saving) return

    // (1) 権限チェック
    try { assertCan(canCreatePurchaseOrder, profile, { userMessage: '発注作成権限がありません' }) }
    catch (e) { alert(e.message); return }

    // (2) 入力バリデーション
    const parent = orders.find((o) => o.id === selectedOrderId)
    if (!parent) { alert('親受注を選択してください'); return }
    const cleanSupplierId = supplierId.trim()
    if (!cleanSupplierId) { alert('仕入先IDは必須です'); return }
    if (!/^[A-Za-z0-9_-]{2,}$/.test(cleanSupplierId)) {
      alert('仕入先IDは英数字・ハイフン・アンダースコアのみ、2文字以上')
      return
    }

    if (picked.length === 0) { alert('明細を1件以上選択してください'); return }

    for (const it of picked) {
      if (!(it.qty > 0)) { alert(`${it.productName}：数量は正の数必須`); return }
      if (it.qty > it.maxQty) {
        alert(`${it.productName}：残数（${it.maxQty}）を超える発注はできません`)
        return
      }
      if (it.unitCost < 0) { alert(`${it.productName}：単価は 0 以上`); return }
    }

    setSaving(true)
    try {
      // poCode は「表示用番号」、一意識別子は Firestore docId（PO.id）。
      // Step 5 で連番化予定までは重複しうる前提。
      const now = new Date()
      const poCode = `PO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getTime() % 100000).padStart(5, '0')}`

      const poItems = picked.map((it, idx) => ({
        lineNo: idx + 1,
        orderItemLineNo: it.orderItemLineNo,
        productId: it.productId,
        qty: Number(it.qty) || 0,
        unitCost: Number(it.unitCost) || 0,
        amount: (Number(it.qty) || 0) * (Number(it.unitCost) || 0),
        receivedQty: 0,
      }))

      const poData = {
        poCode,
        orderId: parent.id,
        orderCodeSnapshot: parent.orderCode, // 一覧表示用のスナップショット（参照簡略化）
        supplierId: cleanSupplierId,
        items: poItems,
        subtotal,
        tax,
        total,
        orderedAt: null,
        expectedDeliveryDate: expectedDate ? Timestamp.fromDate(new Date(expectedDate)) : null,
        purchaseStatus: PURCHASE_STATUS.DRAFT,
        approvedAt: null,
        approvedBy: null,
        deletedAt: null,
        deletedBy: null,
        // company：write-side boundary。create 時に currentCompany を強制セット。
        // update 時は変更不可（doTransition で除外）。
        company: company.key,
        // version：監査・将来拡張用。compare-and-swap は Phase 2 で実装予定。
        version: 1,
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        updatedAt: serverTimestamp(),
        updatedBy: profile.uid,
      }

      // (3) スキーマ事前検証
      validatePurchaseOrder(poData, { isCreate: true })

      // (4) batch 直前に権限再チェック
      assertCan(canCreatePurchaseOrder, profile, { userMessage: '発注作成権限がありません' })

      // writeBatch で PO + AuditLog を原子的に書き込む
      // Note: Order.items.allocatedQty の更新は Phase 2 で自動化予定。
      //       Phase 1 では「Order 集計表示と PO 実体の責務分離」のため手動更新もしない。
      const batch = writeBatch(db)
      const poRef = doc(collection(db, ERP_COLLECTIONS.PurchaseOrder))
      batch.set(poRef, poData)
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.PurchaseOrder,
        docId: poRef.id,
        action: 'create',
        before: null,
        after: poData,
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
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">新規発注</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >✕</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-700">親受注 *</label>
            {orderLoading ? (
              <div className="mt-1 text-sm text-gray-400">読み込み中...</div>
            ) : orders.length === 0 ? (
              <div className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                発注可能な受注（confirmed 以降）がありません。先に受注画面で受注を確定してください。
              </div>
            ) : (
              <select
                value={selectedOrderId}
                onChange={(e) => setSelectedOrderId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">受注を選択してください</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderCode}（{o.clientId} / {fmtDate(o.orderDate)} / {fmtYen(o.total)} / {o.orderStatus}）
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">仕入先ID *</label>
            <input
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              placeholder="例: BS-0001（bp_suppliers のID）"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">予定納期</label>
            <input
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {items.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-700">発注する明細を選択（残数の範囲内で数量・単価調整可）</label>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 w-8"></th>
                    <th className="px-2 py-1.5 text-left">商品</th>
                    <th className="px-2 py-1.5 text-right">受注数</th>
                    <th className="px-2 py-1.5 text-right">残数</th>
                    <th className="px-2 py-1.5 text-right">発注数量</th>
                    <th className="px-2 py-1.5 text-right">単価（原価）</th>
                    <th className="px-2 py-1.5 text-right">小計</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={i} className={`border-t border-gray-100 ${r.pick ? 'bg-indigo-50/30' : ''}`}>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={r.pick}
                          onChange={() => togglePick(i)}
                          disabled={r.maxQty <= 0}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-[10px] text-gray-400">{r.productId}</div>
                      </td>
                      <td className="px-2 py-1 text-right text-gray-500">
                        {(items.find((x) => x.lineNo === r.lineNo)?.maxQty ?? 0) + (items.find((x) => x.lineNo === r.lineNo)?.qty ?? 0) /* 表示上の参考値 */}
                      </td>
                      <td className="px-2 py-1 text-right text-xs">
                        <span className={r.maxQty <= 0 ? 'text-red-400' : 'text-gray-700'}>{r.maxQty}</span>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          max={r.maxQty}
                          value={r.qty}
                          onChange={(e) => updateItem(i, 'qty', e.target.value)}
                          disabled={!r.pick}
                          className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          value={r.unitCost}
                          onChange={(e) => updateItem(i, 'unitCost', e.target.value)}
                          disabled={!r.pick}
                          className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs disabled:bg-gray-50 disabled:text-gray-400"
                        />
                      </td>
                      <td className="px-2 py-1 text-right text-xs">
                        {r.pick ? fmtYen((Number(r.qty) || 0) * (Number(r.unitCost) || 0)) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex justify-end gap-6 text-sm">
              <div>小計：<span className="font-medium">{fmtYen(subtotal)}</span></div>
              <div>税：<span className="font-medium">{fmtYen(tax)}</span></div>
              <div className="text-base font-bold">税込：{fmtYen(total)}</div>
            </div>
          </div>
        )}

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
// 詳細ドロワー（ステータス遷移・承認・取消）
// ================================================================
function PurchaseOrderDetail({ po, profile, onClose, onChanged }) {
  const [busy, setBusy] = useState(false)
  const nextStates = getNextStates('purchase', po.purchaseStatus)

  // busy 中は backdrop click / Esc 無効化
  useEffect(() => {
    if (!busy) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [busy])
  const handleBackdropClose = () => { if (!busy) onClose() }

  const doTransition = async (to) => {
    if (busy) return

    const isApprove = po.purchaseStatus === PURCHASE_STATUS.DRAFT && to === PURCHASE_STATUS.APPROVED
    const isSend = po.purchaseStatus === PURCHASE_STATUS.APPROVED && to === PURCHASE_STATUS.SENT
    const isCancel = to === PURCHASE_STATUS.CANCELLED

    // (1) 権限チェック：batch 作成前
    if (isApprove) {
      try { assertCan(canApprovePurchaseOrder, profile, { userMessage: '発注承認権限がありません' }) }
      catch (e) { alert(e.message); return }
    }
    if (isSend) {
      try { assertCan(canSendPurchaseOrder, profile, { userMessage: '発注送信権限がありません' }) }
      catch (e) { alert(e.message); return }
    }
    if (isCancel) {
      try { assertCan(canCancelPurchaseOrder, profile, { userMessage: '発注取消権限がありません' }) }
      catch (e) { alert(e.message); return }
    }

    // (2) ステータス遷移検証
    try { assertTransition('purchase', po.purchaseStatus, to) }
    catch (e) { alert(e.message); return }

    // (3) 破壊的操作は理由必須
    let reason = null
    if (isCancel) {
      reason = window.prompt('取消理由を入力してください（必須）')
      if (!reason || !reason.trim()) { alert('理由は必須です'); return }
    }

    setBusy(true)
    try {
      // (4) batch 直前の最後の砦
      if (isApprove) assertCan(canApprovePurchaseOrder, profile, { userMessage: '発注承認権限がありません' })
      if (isSend) assertCan(canSendPurchaseOrder, profile, { userMessage: '発注送信権限がありません' })
      if (isCancel) assertCan(canCancelPurchaseOrder, profile, { userMessage: '発注取消権限がありません' })

      const batch = writeBatch(db)
      const poRef = doc(db, ERP_COLLECTIONS.PurchaseOrder, po.id)
      const now = serverTimestamp()

      // company は update で触らない（write-side boundary）
      const afterPartial = {
        purchaseStatus: to,
        updatedAt: now,
        updatedBy: profile.uid,
        version: (po.version || 1) + 1,
      }
      if (isApprove) {
        afterPartial.approvedAt = now
        afterPartial.approvedBy = profile.uid
      }
      if (isSend) {
        afterPartial.orderedAt = now
      }
      batch.update(poRef, afterPartial)

      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.PurchaseOrder,
        docId: po.id,
        action: isCancel ? 'cancel' : 'status_change',
        before: {
          purchaseStatus: po.purchaseStatus,
          version: po.version || 1,
          approvedAt: po.approvedAt || null,
          approvedBy: po.approvedBy || null,
          orderedAt: po.orderedAt || null,
        },
        after: {
          purchaseStatus: to,
          version: (po.version || 1) + 1,
          approvedAt: isApprove ? now : (po.approvedAt || null),
          approvedBy: isApprove ? profile.uid : (po.approvedBy || null),
          orderedAt: isSend ? now : (po.orderedAt || null),
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleBackdropClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{po.poCode}</h2>
            <div className="mt-1 flex items-center gap-2">
              <StatusChip status={po.purchaseStatus} />
              <span className="text-xs text-gray-500">v{po.version || 1}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2">
            <span className="text-gray-500 text-xs">親受注：</span>
            <Link
              to="/admin/erp/orders"
              className="font-mono text-xs text-indigo-600 hover:underline"
            >
              {po.orderCodeSnapshot || po.orderId}
            </Link>
          </div>
          <div><span className="text-gray-500 text-xs">仕入先：</span>{po.supplierId}</div>
          <div><span className="text-gray-500 text-xs">予定納期：</span>{fmtDate(po.expectedDeliveryDate)}</div>
          <div><span className="text-gray-500 text-xs">承認：</span>{po.approvedAt ? fmtDate(po.approvedAt) : '未承認'}</div>
          <div><span className="text-gray-500 text-xs">発注日：</span>{fmtDate(po.orderedAt)}</div>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-gray-700">明細</div>
          <table className="w-full rounded border border-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-2 py-1 text-left">商品ID</th>
                <th className="px-2 py-1 text-center">親行</th>
                <th className="px-2 py-1 text-right">数量</th>
                <th className="px-2 py-1 text-right">単価</th>
                <th className="px-2 py-1 text-right">小計</th>
                <th className="px-2 py-1 text-right">入庫済</th>
              </tr>
            </thead>
            <tbody>
              {(po.items || []).map((it) => (
                <tr key={it.lineNo} className="border-t border-gray-100">
                  <td className="px-2 py-1 font-mono text-xs">{it.productId}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-gray-400">#{it.orderItemLineNo}</td>
                  <td className="px-2 py-1 text-right">{it.qty}</td>
                  <td className="px-2 py-1 text-right">{fmtYen(it.unitCost)}</td>
                  <td className="px-2 py-1 text-right">{fmtYen(it.amount)}</td>
                  <td className="px-2 py-1 text-right text-gray-500">{it.receivedQty || 0}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 text-xs">
              <tr><td colSpan="4" className="px-2 py-1 text-right">小計</td><td className="px-2 py-1 text-right">{fmtYen(po.subtotal)}</td><td /></tr>
              <tr><td colSpan="4" className="px-2 py-1 text-right">税</td><td className="px-2 py-1 text-right">{fmtYen(po.tax)}</td><td /></tr>
              <tr><td colSpan="4" className="px-2 py-1 text-right font-bold">税込</td><td className="px-2 py-1 text-right font-bold">{fmtYen(po.total)}</td><td /></tr>
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
              const isApprove = po.purchaseStatus === PURCHASE_STATUS.DRAFT && next === PURCHASE_STATUS.APPROVED
              const isSend = po.purchaseStatus === PURCHASE_STATUS.APPROVED && next === PURCHASE_STATUS.SENT
              const isCancel = next === PURCHASE_STATUS.CANCELLED
              const needsPermission =
                (isApprove && !canApprovePurchaseOrder(profile))
                || (isSend && !canSendPurchaseOrder(profile))
                || (isCancel && !canCancelPurchaseOrder(profile))
              const label = isApprove
                ? '✅ 承認（draft → approved）'
                : isSend
                  ? '📤 送信（supplier へ通知）'
                  : isCancel
                    ? '❌ 取消'
                    : `→ ${STATUS_LABEL[next] || next}`
              return (
                <button
                  key={next}
                  disabled={busy || needsPermission}
                  onClick={() => doTransition(next)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    isCancel
                      ? 'border border-red-300 bg-white text-red-700 hover:bg-red-50'
                      : isApprove
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : isSend
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  } disabled:opacity-50`}
                  title={needsPermission ? '権限がありません' : ''}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-gray-400">
            ※ supplier ロールは未実装のため、送信・受領の全操作を admin/internal が代行します。
            将来 supplier アカウントを作成しても、本画面のデータ構造はそのまま互換。
          </p>
        </div>
      </div>
    </div>
  )
}
