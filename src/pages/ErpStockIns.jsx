/**
 * ERP 入庫画面（Phase 1 Step 4）
 *
 * 機能:
 *   - 一覧表示
 *   - 新規作成：PO を選択 → 明細を展開 → 倉庫 / 予定数量指定
 *   - 詳細：ステータス遷移 pending → arrived → inspecting → accepted/partial_accepted → stocked / rejected
 *   - stocked 遷移時：Inventory への加算を writeBatch で同時書き込み
 *
 * 重要な設計注記（Step 2-3 から引き継ぎ）:
 *   - stockInCode は表示用番号、一意識別子は Firestore docId
 *   - version は監査・将来拡張用、compare-and-swap は Phase 2 実装予定
 *   - company 境界：create 時強制セット、update 時不変
 *   - AuditLog は AUDITABLE_FIELDS により自動絞込
 *   - 物理削除禁止（rules で allow delete: if false）
 *
 * Step 4 固有:
 *   - stocked 遷移時は StockIn + Inventory + AuditLog を writeBatch で原子的に書き込み
 *   - Inventory docId = {productId}_{lotNumber|'nolot'}_{warehouseId}
 *   - Inventory が存在しなければ新規作成、存在すれば qty 加算
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
  canInputStockIn,
  canApproveStockIn,
  assertCan,
} from '../lib/permissions.js'
import { ERP_COLLECTIONS } from '../lib/erp/collections.js'
import { inventoryDocId, validateStockIn } from '../lib/erp/schema.js'
import {
  WAREHOUSE_STATUS,
  assertTransition,
  getNextStates,
} from '../lib/erp/statusMachine.js'
import { addAuditToBatch, buildRetryBlockedMessage } from '../lib/erp/auditLog.js'

const STATUS_LABEL = {
  pending: '入庫待ち',
  arrived: '到着',
  inspecting: '検品中',
  accepted: '合格',
  partial_accepted: '一部合格',
  stocked: '在庫反映済',
  rejected: '不合格',
}
const STATUS_COLOR = {
  pending: 'bg-gray-100 text-gray-700',
  arrived: 'bg-blue-100 text-blue-800',
  inspecting: 'bg-amber-100 text-amber-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  partial_accepted: 'bg-amber-100 text-amber-900',
  stocked: 'bg-emerald-200 text-emerald-900',
  rejected: 'bg-red-100 text-red-800',
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

export default function ErpStockIns() {
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
        collection(db, ERP_COLLECTIONS.StockIn),
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
  const allowCreate = canInputStockIn(profile)

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">入庫（ERP）</h1>
          <p className="text-xs text-gray-500">
            {company.name}（{company.key}）— {list.length} 件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">🔄 再取得</button>
          {allowCreate && (
            <button onClick={() => setShowForm(true)} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
              + 新規入庫
            </button>
          )}
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">読み込み中...</div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">入庫データがありません</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">入庫番号</th>
                  <th className="px-3 py-2 text-left">親発注</th>
                  <th className="px-3 py-2 text-left">商品</th>
                  <th className="px-3 py-2 text-left">倉庫</th>
                  <th className="px-3 py-2 text-right">予定 / 実績</th>
                  <th className="px-3 py-2 text-center">状態</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{p.stockInCode}</td>
                    <td className="px-3 py-2 font-mono text-xs text-indigo-600">{p.poCodeSnapshot || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{p.productId}</td>
                    <td className="px-3 py-2">{p.warehouseId}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(p.plannedQty)} / {p.actualQty != null ? fmtNum(p.actualQty) : '—'}</td>
                    <td className="px-3 py-2 text-center"><StatusChip status={p.warehouseStatus} /></td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setSelectedId(p.id)} className="text-xs text-indigo-600 hover:underline">詳細 →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <StockInForm
          profile={profile}
          company={company}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load() }}
        />
      )}
      {selected && (
        <StockInDetail
          stockIn={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onChanged={() => load()}
        />
      )}
    </div>
  )
}

// ================================================================
// 新規作成（PO 由来）
// ================================================================
function StockInForm({ profile, company, onClose, onSaved }) {
  const [pos, setPos] = useState([])
  const [poLoading, setPoLoading] = useState(true)
  const [selectedPoId, setSelectedPoId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  // items: { pick, lineNo, productId, plannedQty, lotNumber, maxQty (= po.qty - po.receivedQty) }
  const [items, setItems] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const q = query(
          collection(db, ERP_COLLECTIONS.PurchaseOrder),
          where('company', '==', company.key),
          orderBy('createdAt', 'desc'),
          limit(50),
        )
        const snap = await getDocs(q)
        // 入庫可能な状態：sent / accepted / in_production / partially_received
        const valid = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => ['sent', 'accepted', 'in_production', 'partially_received'].includes(p.purchaseStatus))
        setPos(valid)
      } catch (e) { console.error(e) }
      finally { setPoLoading(false) }
    })()
  }, [company.key])

  useEffect(() => {
    if (!selectedPoId) { setItems([]); return }
    const p = pos.find((x) => x.id === selectedPoId)
    if (!p) return
    setItems((p.items || []).map((it) => {
      const maxQty = Math.max(0, (it.qty || 0) - (it.receivedQty || 0))
      return {
        pick: false,
        lineNo: it.lineNo,
        productId: it.productId,
        plannedQty: maxQty,
        lotNumber: '',
        maxQty,
      }
    }))
  }, [selectedPoId, pos])

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
    try { assertCan(canInputStockIn, profile, { userMessage: '入庫作成権限がありません' }) }
    catch (e) { alert(e.message); return }

    const parent = pos.find((x) => x.id === selectedPoId)
    if (!parent) { alert('親発注を選択してください'); return }
    const cleanWarehouseId = warehouseId.trim()
    if (!cleanWarehouseId) { alert('倉庫IDは必須です'); return }
    if (!/^[A-Za-z0-9_-]{2,}$/.test(cleanWarehouseId)) {
      alert('倉庫IDは英数字・ハイフン・アンダースコアのみ、2文字以上')
      return
    }
    if (picked.length === 0) { alert('明細を1件以上選択してください'); return }
    for (const it of picked) {
      if (!(it.plannedQty > 0)) { alert(`${it.productId}: 予定数量は正の数必須`); return }
      if (it.plannedQty > it.maxQty) { alert(`${it.productId}: 残数(${it.maxQty})を超えられません`); return }
    }

    setSaving(true)
    try {
      assertCan(canInputStockIn, profile, { userMessage: '入庫作成権限がありません' })

      // stockInCode：表示用番号。一意識別子は Firestore docId。
      const now = new Date()
      const codePrefix = `SI-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-`

      const batch = writeBatch(db)
      // 明細ごとに 1 StockIn レコードを作成（単純化のため）
      const stockInIds = []
      for (let idx = 0; idx < picked.length; idx += 1) {
        const it = picked[idx]
        const stockInCode = `${codePrefix}${String(now.getTime() % 100000).padStart(5, '0')}-${idx + 1}`
        const data = {
          stockInCode,
          purchaseOrderId: parent.id,
          poCodeSnapshot: parent.poCode,
          productionResultId: null, // Phase 1 は製造連動なし
          productId: it.productId,
          lotNumber: it.lotNumber?.trim() || null, // Phase 1 では optional
          warehouseId: cleanWarehouseId,
          plannedQty: Number(it.plannedQty) || 0,
          actualQty: null,
          inspectionResult: null,
          receivedAt: null,
          receivedBy: null,
          warehouseStatus: WAREHOUSE_STATUS.PENDING,
          deletedAt: null,
          deletedBy: null,
          company: company.key,
          version: 1,
          createdAt: serverTimestamp(),
          createdBy: profile.uid,
          updatedAt: serverTimestamp(),
          updatedBy: profile.uid,
        }
        validateStockIn(data, { isCreate: true })
        const ref = doc(collection(db, ERP_COLLECTIONS.StockIn))
        batch.set(ref, data)
        addAuditToBatch(batch, {
          collection: ERP_COLLECTIONS.StockIn,
          docId: ref.id,
          action: 'create',
          before: null,
          after: data,
          profile,
        })
        stockInIds.push(ref.id)
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
          <h2 className="text-lg font-bold text-gray-900">新規入庫</h2>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-700">親発注 *</label>
            {poLoading ? (
              <div className="mt-1 text-sm text-gray-400">読み込み中...</div>
            ) : pos.length === 0 ? (
              <div className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                入庫可能な発注がありません（送信済み以降の状態が対象）
              </div>
            ) : (
              <select value={selectedPoId} onChange={(e) => setSelectedPoId(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">発注を選択</option>
                {pos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.poCode}（{p.supplierId} / {p.purchaseStatus} / {p.items?.length || 0}品目）
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-700">倉庫ID *</label>
            <input
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              placeholder="例: WH-TOKYO"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {items.length > 0 && (
          <div className="mt-6">
            <label className="text-xs font-medium text-gray-700">入庫対象（残数の範囲内で予定数量を指定）</label>
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 w-8" />
                    <th className="px-2 py-1.5 text-left">商品ID</th>
                    <th className="px-2 py-1.5 text-right">残数</th>
                    <th className="px-2 py-1.5 text-right">予定数量</th>
                    <th className="px-2 py-1.5 text-left">ロット番号（任意）</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={i} className={`border-t border-gray-100 ${r.pick ? 'bg-indigo-50/30' : ''}`}>
                      <td className="px-2 py-1 text-center">
                        <input type="checkbox" checked={r.pick} onChange={() => togglePick(i)} disabled={r.maxQty <= 0} />
                      </td>
                      <td className="px-2 py-1 font-mono text-xs">{r.productId}</td>
                      <td className={`px-2 py-1 text-right text-xs ${r.maxQty <= 0 ? 'text-red-400' : 'text-gray-700'}`}>{r.maxQty}</td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" max={r.maxQty} value={r.plannedQty} onChange={(e) => updateItem(i, 'plannedQty', e.target.value)} disabled={!r.pick} className="w-full rounded border border-gray-300 px-2 py-1 text-right text-xs disabled:bg-gray-50" />
                      </td>
                      <td className="px-2 py-1">
                        <input value={r.lotNumber} onChange={(e) => updateItem(i, 'lotNumber', e.target.value)} disabled={!r.pick} placeholder="Phase 1 では任意" className="w-full rounded border border-gray-300 px-2 py-1 text-xs disabled:bg-gray-50" />
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
// 詳細ドロワー（ステータス遷移＋入庫確定時の Inventory 加算）
// ================================================================
function StockInDetail({ stockIn, profile, onClose, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [actualQty, setActualQty] = useState(stockIn.actualQty ?? '')
  const [inspectionResult, setInspectionResult] = useState(stockIn.inspectionResult || 'ok')
  const nextStates = getNextStates('warehouse', stockIn.warehouseStatus)

  useEffect(() => {
    if (!busy) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [busy])
  const handleBackdropClose = () => { if (!busy) onClose() }

  const allowApprove = canApproveStockIn(profile)

  const doTransition = async (to) => {
    if (busy) return

    // 権限チェック：accepted 以降は admin のみ
    const needsAdminApproval = [WAREHOUSE_STATUS.ACCEPTED, WAREHOUSE_STATUS.PARTIAL_ACCEPTED, WAREHOUSE_STATUS.REJECTED].includes(to)
    if (needsAdminApproval) {
      try { assertCan(canApproveStockIn, profile, { userMessage: '入庫承認権限がありません' }) }
      catch (e) { alert(e.message); return }
    } else {
      try { assertCan(canInputStockIn, profile, { userMessage: '入庫更新権限がありません' }) }
      catch (e) { alert(e.message); return }
    }

    try { assertTransition('warehouse', stockIn.warehouseStatus, to) }
    catch (e) { alert(e.message); return }

    // 検品完了時は actualQty / inspectionResult 必須
    if ([WAREHOUSE_STATUS.ACCEPTED, WAREHOUSE_STATUS.PARTIAL_ACCEPTED, WAREHOUSE_STATUS.REJECTED].includes(to)) {
      if (actualQty === '' || actualQty === null) { alert('実数量は必須'); return }
      const a = Number(actualQty)
      if (!Number.isFinite(a) || a < 0) { alert('実数量は 0 以上の数値'); return }
    }

    // stocked = Inventory へ加算のタイミング
    const isStockedTransition = to === WAREHOUSE_STATUS.STOCKED

    setBusy(true)
    try {
      // 最後の砦：再度権限チェック
      if (needsAdminApproval) assertCan(canApproveStockIn, profile)
      else assertCan(canInputStockIn, profile)

      const batch = writeBatch(db)
      const now = serverTimestamp()
      const stockInRef = doc(db, ERP_COLLECTIONS.StockIn, stockIn.id)

      const afterPartial = {
        warehouseStatus: to,
        updatedAt: now,
        updatedBy: profile.uid,
        version: (stockIn.version || 1) + 1,
      }
      if ([WAREHOUSE_STATUS.ACCEPTED, WAREHOUSE_STATUS.PARTIAL_ACCEPTED, WAREHOUSE_STATUS.REJECTED].includes(to)) {
        afterPartial.actualQty = Number(actualQty)
        afterPartial.inspectionResult = inspectionResult
        afterPartial.receivedAt = now
        afterPartial.receivedBy = profile.uid
      }
      batch.update(stockInRef, afterPartial)

      // Inventory 加算：stocked 遷移時のみ、同一 batch で書き込み
      if (isStockedTransition) {
        const addQty = Number(stockIn.actualQty ?? actualQty) || 0
        if (addQty > 0) {
          const invId = inventoryDocId(stockIn.productId, stockIn.lotNumber, stockIn.warehouseId)
          const invRef = doc(db, ERP_COLLECTIONS.Inventory, invId)
          const invSnap = await getDoc(invRef)
          if (invSnap.exists()) {
            const cur = invSnap.data()
            const newQty = (cur.qty || 0) + addQty
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
              reason: `入庫確定 (${stockIn.stockInCode})`,
            })
          } else {
            // 新規 Inventory レコード
            const invData = {
              productId: stockIn.productId,
              lotNumber: stockIn.lotNumber || null,
              warehouseId: stockIn.warehouseId,
              qty: addQty,
              reservedQty: 0,
              availableQty: addQty,
              lastMovementAt: now,
              deletedAt: null,
              deletedBy: null,
              company: stockIn.company,
              version: 1,
              createdAt: now,
              createdBy: profile.uid,
              updatedAt: now,
              updatedBy: profile.uid,
            }
            batch.set(invRef, invData)
            addAuditToBatch(batch, {
              collection: ERP_COLLECTIONS.Inventory,
              docId: invId,
              action: 'create',
              before: null,
              after: invData,
              profile,
              reason: `入庫確定で新規作成 (${stockIn.stockInCode})`,
            })
          }
        }
      }

      // StockIn 側の AuditLog
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.StockIn,
        docId: stockIn.id,
        action: 'status_change',
        before: {
          warehouseStatus: stockIn.warehouseStatus,
          version: stockIn.version || 1,
          actualQty: stockIn.actualQty,
          inspectionResult: stockIn.inspectionResult,
        },
        after: {
          warehouseStatus: to,
          version: (stockIn.version || 1) + 1,
          actualQty: afterPartial.actualQty ?? stockIn.actualQty,
          inspectionResult: afterPartial.inspectionResult ?? stockIn.inspectionResult,
        },
        profile,
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

  const needsActualInput = [WAREHOUSE_STATUS.INSPECTING].includes(stockIn.warehouseStatus)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleBackdropClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{stockIn.stockInCode}</h2>
            <div className="mt-1 flex items-center gap-2">
              <StatusChip status={stockIn.warehouseStatus} />
              <span className="text-xs text-gray-500">v{stockIn.version || 1}</span>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-gray-500 text-xs">商品ID：</span><span className="font-mono">{stockIn.productId}</span></div>
          <div><span className="text-gray-500 text-xs">ロット：</span>{stockIn.lotNumber || '—'}</div>
          <div><span className="text-gray-500 text-xs">倉庫：</span>{stockIn.warehouseId}</div>
          <div><span className="text-gray-500 text-xs">親発注：</span>{stockIn.poCodeSnapshot || stockIn.purchaseOrderId}</div>
          <div><span className="text-gray-500 text-xs">予定数量：</span>{fmtNum(stockIn.plannedQty)}</div>
          <div><span className="text-gray-500 text-xs">実数量：</span>{stockIn.actualQty != null ? fmtNum(stockIn.actualQty) : '—'}</div>
          <div><span className="text-gray-500 text-xs">検品結果：</span>{stockIn.inspectionResult || '—'}</div>
          <div><span className="text-gray-500 text-xs">受領日時：</span>{fmtDate(stockIn.receivedAt)}</div>
        </div>

        {needsActualInput && (
          <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
            <div className="text-xs font-medium text-amber-900">検品結果を入力してから accepted / partial_accepted / rejected に遷移</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-700">実数量</label>
                <input
                  type="number"
                  min="0"
                  value={actualQty}
                  onChange={(e) => setActualQty(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-gray-700">検品結果</label>
                <select value={inspectionResult} onChange={(e) => setInspectionResult(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="ok">ok</option>
                  <option value="partial">partial</option>
                  <option value="reject">reject</option>
                </select>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 space-y-2">
          <div className="text-xs font-medium text-gray-700">ステータス操作</div>
          <div className="flex flex-wrap gap-2">
            {nextStates.length === 0 && (
              <span className="text-xs text-gray-400">この状態からの遷移はありません</span>
            )}
            {nextStates.map((next) => {
              const isStocked = next === WAREHOUSE_STATUS.STOCKED
              const needsAdmin = [WAREHOUSE_STATUS.ACCEPTED, WAREHOUSE_STATUS.PARTIAL_ACCEPTED, WAREHOUSE_STATUS.REJECTED].includes(next)
              const disallowed = needsAdmin && !allowApprove
              const label = isStocked
                ? '📦 在庫反映（Inventory加算）'
                : `→ ${STATUS_LABEL[next] || next}`
              return (
                <button
                  key={next}
                  disabled={busy || disallowed}
                  onClick={() => doTransition(next)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    isStocked
                      ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                      : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  } disabled:opacity-50`}
                  title={disallowed ? '管理者権限が必要' : ''}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-gray-400">
            ※ 「在庫反映」実行時に同一 writeBatch で Inventory レコードを加算・AuditLog 記録します。
            楽観ロック未実装のため、同時加算時の競合は Phase 2 で transaction 化予定。
          </p>
        </div>
      </div>
    </div>
  )
}
