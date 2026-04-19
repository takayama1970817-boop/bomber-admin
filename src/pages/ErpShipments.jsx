/**
 * ERP 出荷画面（Phase 1 Step 4）
 *
 * 機能:
 *   - 一覧表示
 *   - 新規作成：Order を選択 → 明細を残数範囲でピック → 倉庫 / 配送先指定
 *   - 詳細：pending → allocated → picked → packed → shipped → delivered
 *   - shipped 遷移時：Inventory への減算を writeBatch で同時書き込み
 *   - cancel（履歴保持、cancelReason 必須）
 *   - correction（元を cancel + 新 Shipment を作成、循環禁止）
 *
 * 重要な設計注記（Step 2-3 から引き継ぎ）:
 *   - shipmentCode は表示用番号、一意識別子は Firestore docId
 *   - version は監査・将来拡張用、compare-and-swap は Phase 2 実装予定
 *   - company 境界：create 時強制セット、update 時不変
 *   - AuditLog は AUDITABLE_FIELDS により自動絞込
 *   - 物理削除禁止（rules で allow delete: if false）
 *
 * Step 4 固有:
 *   - shipped 遷移時は Shipment + Inventory（減算）+ AuditLog を writeBatch で原子的に書き込み
 *   - cancel + correction：元 Shipment の supersededBy / cancelledAt / cancelReason 記録
 *     新 Shipment の correctionOf に元 ID。assertNoCycle / assertNotAlreadySuperseded で循環防止
 *   - 楽観ロック未実装のため同時書き込み競合は Phase 2 で解消予定
 */
import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
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
  canCreateShipment,
  canInputShipment,
  canApproveShipment,
  canCancelShipment,
  assertCan,
} from '../lib/permissions.js'
import { ERP_COLLECTIONS } from '../lib/erp/collections.js'
import { inventoryDocId, validateShipment, validateShipmentCancel } from '../lib/erp/schema.js'
import {
  SHIPMENT_STATUS,
  assertTransition,
  getNextStates,
} from '../lib/erp/statusMachine.js'
import { addAuditToBatch, buildRetryBlockedMessage } from '../lib/erp/auditLog.js'
import { assertNoCycle, assertNotAlreadySuperseded } from '../lib/erp/shipmentChain.js'

const STATUS_LABEL = {
  pending: '待機',
  allocated: '引当済',
  picked: 'ピッキング済',
  packed: '梱包済',
  shipped: '出荷済',
  delivered: '配達済',
  partial_delivered: '一部配達',
  cancelled: '取消',
}
const STATUS_COLOR = {
  pending: 'bg-gray-100 text-gray-700',
  allocated: 'bg-blue-100 text-blue-800',
  picked: 'bg-cyan-100 text-cyan-800',
  packed: 'bg-indigo-100 text-indigo-800',
  shipped: 'bg-emerald-100 text-emerald-800',
  delivered: 'bg-emerald-200 text-emerald-900',
  partial_delivered: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-red-100 text-red-700',
}

const fmtNum = (n) => (Number(n) || 0).toLocaleString()
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

export default function ErpShipments() {
  const { profile } = useAuth()
  const { company } = useCompany()

  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [selectedId, setSelectedId] = useState(null)

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = query(
        collection(db, ERP_COLLECTIONS.Shipment),
        where('company', '==', company.key),
        orderBy('createdAt', 'desc'),
      )
      const snap = await getDocs(q)
      setList(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [company.key])

  const selected = list.find((p) => p.id === selectedId)
  const allowCreate = canCreateShipment(profile)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">出荷（ERP）</h1>
          <p className="text-xs text-gray-500">
            {company.name}（{company.key}）— {list.length} 件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">🔄 再取得</button>
          {allowCreate && (
            <button onClick={() => setShowForm(true)} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
              + 新規出荷
            </button>
          )}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">読み込み中...</div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">出荷データがありません</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">出荷番号</th>
                  <th className="px-3 py-2 text-left">親受注</th>
                  <th className="px-3 py-2 text-left">倉庫</th>
                  <th className="px-3 py-2 text-right">件数</th>
                  <th className="px-3 py-2 text-center">状態</th>
                  <th className="px-3 py-2 text-center">履歴</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{s.shipmentCode}</td>
                    <td className="px-3 py-2 font-mono text-xs text-indigo-600">{s.orderCodeSnapshot || '—'}</td>
                    <td className="px-3 py-2">{s.warehouseId}</td>
                    <td className="px-3 py-2 text-right">{s.items?.length || 0}</td>
                    <td className="px-3 py-2 text-center"><StatusChip status={s.shipmentStatus} /></td>
                    <td className="px-3 py-2 text-center text-[10px]">
                      {s.correctionOf && <span className="rounded bg-blue-100 px-1 py-0.5 text-blue-700">修正</span>}
                      {s.supersededBy && <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-red-700">旧</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setSelectedId(s.id)} className="text-xs text-indigo-600 hover:underline">詳細 →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <ShipmentForm
          profile={profile}
          company={company}
          correctionOf={null}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load() }}
        />
      )}
      {selected && (
        <ShipmentDetail
          ship={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onChanged={() => load()}
        />
      )}
    </div>
  )
}

// ================================================================
// 新規作成（Order 由来）
// 注: correctionOf がセットされている場合は correction レコードとして作成
// ================================================================
function ShipmentForm({ profile, company, correctionOf, correctionBase, onClose, onSaved }) {
  const [orders, setOrders] = useState([])
  const [orderLoading, setOrderLoading] = useState(true)
  const [selectedOrderId, setSelectedOrderId] = useState(correctionBase?.orderId || '')
  const [warehouseId, setWarehouseId] = useState(correctionBase?.warehouseId || '')
  const [destinationId, setDestinationId] = useState(correctionBase?.destinationId || '')
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10))
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)

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
          .filter((o) => ['confirmed', 'partially_allocated', 'fully_allocated', 'partially_shipped'].includes(o.orderStatus))
        setOrders(list)
      } catch (e) { console.error(e) }
      finally { setOrderLoading(false) }
    })()
  }, [company.key])

  useEffect(() => {
    if (!selectedOrderId) { setItems([]); return }
    const o = orders.find((x) => x.id === selectedOrderId)
    if (!o) return
    setItems((o.items || []).map((it) => {
      const maxQty = Math.max(0, (it.qty || 0) - (it.shippedQty || 0))
      // correctionBase がある場合、元 Shipment の items と一致する行を初期ピックしておく
      const baseItem = correctionBase?.items?.find((bi) => bi.orderItemLineNo === it.lineNo)
      return {
        pick: !!baseItem,
        lineNo: it.lineNo,
        orderItemLineNo: it.lineNo,
        productId: it.productId,
        productName: it.productName,
        qty: baseItem?.qty ?? maxQty,
        lotNumber: baseItem?.lotNumber || '',
        maxQty: maxQty + (baseItem?.qty || 0), // correction の時は元 shipment 分は戻した残数とみなす
      }
    }))
  }, [selectedOrderId, orders, correctionBase])

  useEffect(() => {
    if (!saving) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [saving])
  const handleBackdropClose = () => { if (!saving) onClose() }

  const updateItem = (i, key, val) => setItems(items.map((r, idx) => idx === i ? { ...r, [key]: val } : r))
  const togglePick = (i) => setItems(items.map((r, idx) => idx === i ? { ...r, pick: !r.pick } : r))

  const picked = items.filter((it) => it.pick)

  const handleSave = async () => {
    if (saving) return
    try { assertCan(canCreateShipment, profile, { userMessage: '出荷作成権限がありません' }) }
    catch (e) { alert(e.message); return }

    const parent = orders.find((o) => o.id === selectedOrderId)
    if (!parent) { alert('親受注を選択してください'); return }
    const cleanWh = warehouseId.trim()
    const cleanDest = destinationId.trim()
    if (!cleanWh) { alert('倉庫IDは必須です'); return }
    if (!cleanDest) { alert('配送先IDは必須です'); return }
    if (!/^[A-Za-z0-9_-]{2,}$/.test(cleanWh)) { alert('倉庫IDは英数字・ハイフン・アンダースコアのみ、2文字以上'); return }
    if (!/^[A-Za-z0-9_-]{2,}$/.test(cleanDest)) { alert('配送先IDは英数字・ハイフン・アンダースコアのみ、2文字以上'); return }
    if (!shipDate) { alert('出荷日は必須'); return }
    if (picked.length === 0) { alert('明細を1件以上選択してください'); return }
    for (const it of picked) {
      if (!(it.qty > 0)) { alert(`${it.productName}: 数量は正の数必須`); return }
      if (it.qty > it.maxQty) { alert(`${it.productName}: 残数(${it.maxQty})を超えられません`); return }
    }

    // correction モードの循環防止チェック
    if (correctionOf) {
      try { await assertNotAlreadySuperseded(correctionOf) }
      catch (e) { alert(e.message); return }
    }

    setSaving(true)
    try {
      assertCan(canCreateShipment, profile)

      const now = new Date()
      const shipmentCode = `SH-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getTime() % 100000).padStart(5, '0')}`

      const shipItems = picked.map((it, idx) => ({
        lineNo: idx + 1,
        orderItemLineNo: it.orderItemLineNo,
        productId: it.productId,
        lotNumber: it.lotNumber?.trim() || null,
        qty: Number(it.qty) || 0,
      }))

      const shipData = {
        shipmentCode,
        orderId: parent.id,
        orderCodeSnapshot: parent.orderCode,
        destinationId: cleanDest,
        warehouseId: cleanWh,
        items: shipItems,
        shipmentDate: Timestamp.fromDate(new Date(shipDate)),
        plannedShipDate: Timestamp.fromDate(new Date(shipDate)),
        shippedAt: null,
        shippedBy: null,
        trackingNumber: null,
        shipmentStatus: SHIPMENT_STATUS.PENDING,
        approvedAt: null,
        approvedBy: null,
        // 履歴ベース修正フィールド
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        correctionOf: correctionOf || null,
        supersededBy: null,
        deletedAt: null,
        deletedBy: null,
        company: company.key,
        version: 1,
        createdAt: serverTimestamp(),
        createdBy: profile.uid,
        updatedAt: serverTimestamp(),
        updatedBy: profile.uid,
      }

      validateShipment(shipData, { isCreate: true })

      // correction モードの循環チェック（新 Shipment ID を仮生成して確認）
      const newShipRef = doc(collection(db, ERP_COLLECTIONS.Shipment))
      if (correctionOf) {
        try { await assertNoCycle(correctionOf, newShipRef.id) }
        catch (e) { alert(e.message); return }
      }

      const batch = writeBatch(db)
      batch.set(newShipRef, shipData)
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.Shipment,
        docId: newShipRef.id,
        action: correctionOf ? 'correction' : 'create',
        before: null,
        after: shipData,
        profile,
      })

      // correction モード：元 Shipment の supersededBy を更新
      if (correctionOf) {
        const origRef = doc(db, ERP_COLLECTIONS.Shipment, correctionOf)
        batch.update(origRef, {
          supersededBy: newShipRef.id,
          updatedAt: serverTimestamp(),
          updatedBy: profile.uid,
          version: ((correctionBase?.version || 1) + 1),
        })
        addAuditToBatch(batch, {
          collection: ERP_COLLECTIONS.Shipment,
          docId: correctionOf,
          action: 'update',
          before: { supersededBy: null },
          after: { supersededBy: newShipRef.id },
          profile,
          reason: `correction Shipment ${shipmentCode} を作成`,
        })
      }

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
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">
            {correctionOf ? '📝 修正出荷を作成（correction）' : '新規出荷'}
          </h2>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        {correctionOf && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            修正元 Shipment ID: <span className="font-mono">{correctionOf}</span>
            （保存時に元 Shipment の supersededBy がセットされます）
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-700">親受注 *</label>
            {orderLoading ? (
              <div className="mt-1 text-sm text-gray-400">読み込み中...</div>
            ) : (
              <select value={selectedOrderId} onChange={(e) => setSelectedOrderId(e.target.value)} disabled={!!correctionOf} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50">
                <option value="">受注を選択</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.orderCode}（{o.clientId} / {fmtDate(o.orderDate)} / {o.orderStatus}）
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">倉庫ID *</label>
            <input value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="例: WH-TOKYO" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">配送先ID *</label>
            <input value={destinationId} onChange={(e) => setDestinationId(e.target.value)} placeholder="例: DST-0001" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">出荷日 *</label>
            <input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        {items.length > 0 && (
          <div className="mt-6">
            <label className="text-xs font-medium text-gray-700">出荷明細（残数の範囲内で数量指定）</label>
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 w-8" />
                    <th className="px-2 py-1.5 text-left">商品</th>
                    <th className="px-2 py-1.5 text-right">残数</th>
                    <th className="px-2 py-1.5 text-right">出荷数量</th>
                    <th className="px-2 py-1.5 text-left">ロット番号（任意）</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={i} className={`border-t border-gray-100 ${r.pick ? 'bg-indigo-50/30' : ''}`}>
                      <td className="px-2 py-1 text-center">
                        <input type="checkbox" checked={r.pick} onChange={() => togglePick(i)} disabled={r.maxQty <= 0} />
                      </td>
                      <td className="px-2 py-1">
                        <div className="font-medium">{r.productName}</div>
                        <div className="text-[10px] text-gray-400">{r.productId}</div>
                      </td>
                      <td className="px-2 py-1 text-right text-xs">
                        <span className={r.maxQty <= 0 ? 'text-red-400' : 'text-gray-700'}>{r.maxQty}</span>
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" max={r.maxQty} value={r.qty} onChange={(e) => updateItem(i, 'qty', e.target.value)} disabled={!r.pick} className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs disabled:bg-gray-50" />
                      </td>
                      <td className="px-2 py-1">
                        <input value={r.lotNumber} onChange={(e) => updateItem(i, 'lotNumber', e.target.value)} disabled={!r.pick} placeholder="任意" className="w-full rounded border border-gray-300 px-2 py-1 text-xs disabled:bg-gray-50" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中...' : '保存（pending）'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// 詳細ドロワー
// ================================================================
function ShipmentDetail({ ship, profile, onClose, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [trackingNumber, setTrackingNumber] = useState(ship.trackingNumber || '')
  const [correctionMode, setCorrectionMode] = useState(false)
  const nextStates = getNextStates('shipment', ship.shipmentStatus)

  useEffect(() => {
    if (!busy) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [busy])
  const handleBackdropClose = () => { if (!busy) onClose() }

  const isCancelled = ship.shipmentStatus === SHIPMENT_STATUS.CANCELLED

  const doTransition = async (to) => {
    if (busy) return

    const isShip = ship.shipmentStatus === SHIPMENT_STATUS.PACKED && to === SHIPMENT_STATUS.SHIPPED
    const isCancel = to === SHIPMENT_STATUS.CANCELLED

    if (isShip) {
      try { assertCan(canApproveShipment, profile, { userMessage: '出荷承認権限がありません' }) }
      catch (e) { alert(e.message); return }
    }
    if (isCancel) {
      try { assertCan(canCancelShipment, profile, { userMessage: '出荷取消権限がありません' }) }
      catch (e) { alert(e.message); return }
    }
    if (!isShip && !isCancel) {
      try { assertCan(canInputShipment, profile, { userMessage: '出荷更新権限がありません' }) }
      catch (e) { alert(e.message); return }
    }

    try { assertTransition('shipment', ship.shipmentStatus, to) }
    catch (e) { alert(e.message); return }

    let reason = null
    if (isCancel) {
      reason = window.prompt('取消理由を入力してください（必須）')
      if (!reason || !reason.trim()) { alert('理由は必須です'); return }
      try { validateShipmentCancel({ cancelReason: reason.trim() }) }
      catch (e) { alert(e.message); return }
    }

    setBusy(true)
    try {
      // 最後の砦
      if (isShip) assertCan(canApproveShipment, profile)
      if (isCancel) assertCan(canCancelShipment, profile)

      const batch = writeBatch(db)
      const now = serverTimestamp()
      const shipRef = doc(db, ERP_COLLECTIONS.Shipment, ship.id)

      const afterPartial = {
        shipmentStatus: to,
        updatedAt: now,
        updatedBy: profile.uid,
        version: (ship.version || 1) + 1,
      }
      if (isShip) {
        afterPartial.shippedAt = now
        afterPartial.shippedBy = profile.uid
        afterPartial.approvedAt = now
        afterPartial.approvedBy = profile.uid
        if (trackingNumber.trim()) afterPartial.trackingNumber = trackingNumber.trim()
      }
      if (isCancel) {
        afterPartial.cancelledAt = now
        afterPartial.cancelledBy = profile.uid
        afterPartial.cancelReason = reason.trim()
      }
      batch.update(shipRef, afterPartial)

      // Inventory 減算：shipped 遷移時のみ
      if (isShip) {
        for (const it of (ship.items || [])) {
          const qty = Number(it.qty) || 0
          if (qty <= 0) continue
          const invId = inventoryDocId(it.productId, it.lotNumber, ship.warehouseId)
          const invRef = doc(db, ERP_COLLECTIONS.Inventory, invId)
          const invSnap = await getDoc(invRef)
          if (!invSnap.exists()) {
            throw new Error(`在庫が見つかりません: ${invId}（入庫が完了していない可能性）`)
          }
          const cur = invSnap.data()
          const newQty = (cur.qty || 0) - qty
          if (newQty < 0) {
            throw new Error(`在庫不足: ${it.productId} / ${it.lotNumber || 'nolot'} — 現在${cur.qty}, 要求${qty}`)
          }
          batch.update(invRef, {
            qty: newQty,
            availableQty: newQty - (cur.reservedQty || 0),
            lastMovementAt: now,
            updatedAt: now,
            updatedBy: profile.uid,
            version: (cur.version || 1) + 1,
          })
          addAuditToBatch(batch, {
            collection: ERP_COLLECTIONS.Inventory,
            docId: invId,
            action: 'update',
            before: { qty: cur.qty || 0, reservedQty: cur.reservedQty || 0, version: cur.version || 1 },
            after: { qty: newQty, reservedQty: cur.reservedQty || 0, version: (cur.version || 1) + 1 },
            profile,
            reason: `出荷確定 (${ship.shipmentCode})`,
          })
        }
      }

      // Shipment 側の AuditLog
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.Shipment,
        docId: ship.id,
        action: isCancel ? 'cancel' : 'status_change',
        before: {
          shipmentStatus: ship.shipmentStatus,
          version: ship.version || 1,
          shippedAt: ship.shippedAt || null,
          shippedBy: ship.shippedBy || null,
          cancelledAt: ship.cancelledAt || null,
          cancelledBy: ship.cancelledBy || null,
          cancelReason: ship.cancelReason || null,
        },
        after: {
          shipmentStatus: to,
          version: (ship.version || 1) + 1,
          shippedAt: afterPartial.shippedAt ?? ship.shippedAt ?? null,
          shippedBy: afterPartial.shippedBy ?? ship.shippedBy ?? null,
          cancelledAt: afterPartial.cancelledAt ?? ship.cancelledAt ?? null,
          cancelledBy: afterPartial.cancelledBy ?? ship.cancelledBy ?? null,
          cancelReason: afterPartial.cancelReason ?? ship.cancelReason ?? null,
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
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{ship.shipmentCode}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusChip status={ship.shipmentStatus} />
              <span className="text-xs text-gray-500">v{ship.version || 1}</span>
              {ship.correctionOf && <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700">修正版</span>}
              {ship.supersededBy && <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] text-red-700">廃止済</span>}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-gray-500 text-xs">親受注：</span>{ship.orderCodeSnapshot || ship.orderId}</div>
          <div><span className="text-gray-500 text-xs">倉庫：</span>{ship.warehouseId}</div>
          <div><span className="text-gray-500 text-xs">配送先：</span>{ship.destinationId}</div>
          <div><span className="text-gray-500 text-xs">出荷日：</span>{fmtDate(ship.shipmentDate)}</div>
          <div><span className="text-gray-500 text-xs">出荷完了：</span>{fmtDate(ship.shippedAt)}</div>
          <div><span className="text-gray-500 text-xs">追跡番号：</span>{ship.trackingNumber || '—'}</div>
          {ship.cancelledAt && (
            <>
              <div className="col-span-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800">
                <strong>取消 ({fmtDate(ship.cancelledAt)})</strong>：{ship.cancelReason}
              </div>
            </>
          )}
          {ship.correctionOf && (
            <div className="col-span-2 text-xs text-blue-700">修正元 ID: <span className="font-mono">{ship.correctionOf}</span></div>
          )}
          {ship.supersededBy && (
            <div className="col-span-2 text-xs text-red-700">修正後 ID: <span className="font-mono">{ship.supersededBy}</span></div>
          )}
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-gray-700">明細</div>
          <table className="w-full rounded border border-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-2 py-1 text-left">商品</th>
                <th className="px-2 py-1 text-center">親行</th>
                <th className="px-2 py-1 text-left">ロット</th>
                <th className="px-2 py-1 text-right">数量</th>
              </tr>
            </thead>
            <tbody>
              {(ship.items || []).map((it) => (
                <tr key={it.lineNo} className="border-t border-gray-100">
                  <td className="px-2 py-1 font-mono text-xs">{it.productId}</td>
                  <td className="px-2 py-1 text-center text-[10px] text-gray-400">#{it.orderItemLineNo}</td>
                  <td className="px-2 py-1 text-xs">{it.lotNumber || '—'}</td>
                  <td className="px-2 py-1 text-right">{fmtNum(it.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {ship.shipmentStatus === SHIPMENT_STATUS.PACKED && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <label className="text-xs text-amber-900">追跡番号（任意）</label>
            <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="例: 1234-5678-9012" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        )}

        {/* 操作ボタン */}
        <div className="mt-6 space-y-3">
          <div className="text-xs font-medium text-gray-700">ステータス操作</div>
          <div className="flex flex-wrap gap-2">
            {nextStates.length === 0 && (
              <span className="text-xs text-gray-400">この状態からの遷移はありません</span>
            )}
            {nextStates.map((next) => {
              const isShip = ship.shipmentStatus === SHIPMENT_STATUS.PACKED && next === SHIPMENT_STATUS.SHIPPED
              const isCancel = next === SHIPMENT_STATUS.CANCELLED
              const needsPermission = (isShip && !canApproveShipment(profile)) || (isCancel && !canCancelShipment(profile))
              const label = isShip
                ? '🚚 出荷確定（在庫減算）'
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
                      : isShip
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  } disabled:opacity-50`}
                  title={needsPermission ? '権限がありません' : ''}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* correction は cancelled かつ supersededBy 未セットの時のみ可能 */}
          {isCancelled && !ship.supersededBy && canCreateShipment(profile) && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
              <p className="mb-2 text-xs text-blue-900">
                この Shipment は取消済み。修正版（correction）を作成できます。作成すると元レコードの supersededBy がセットされ、以降はチェーンの一部として不変化します。
              </p>
              <button
                onClick={() => setCorrectionMode(true)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                📝 修正出荷を作成
              </button>
            </div>
          )}
        </div>
      </div>

      {correctionMode && (
        <ShipmentForm
          profile={profile}
          company={{ key: ship.company, name: ship.company }}
          correctionOf={ship.id}
          correctionBase={ship}
          onClose={() => setCorrectionMode(false)}
          onSaved={() => { setCorrectionMode(false); onChanged(); onClose() }}
        />
      )}
    </div>
  )
}
