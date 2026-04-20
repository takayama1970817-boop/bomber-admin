/**
 * ERP 在庫画面（Phase 1 Step 4）
 *
 * 機能:
 *   - 一覧表示（company でフィルタ、productId / warehouseId で絞込）
 *   - 手動調整（admin のみ、理由必須、+/- 数量入力）
 *   - 基本は入庫/出荷経由で自動更新される想定だが、Phase 1 は手動併用
 *
 * 重要な設計注記:
 *   - docId は「{productId}_{lotNumber|'nolot'}_{warehouseId}」で一意化
 *   - version は監査・将来拡張用。compare-and-swap（楽観ロック）は Phase 2 で実装。
 *     現状は「同時調整時の競合保護はなし」。画面上でも明示する。
 *   - company 境界：create 時は currentCompany 強制、update 時は触らない。
 *   - AuditLog は addAuditToBatch 内で AUDITABLE_FIELDS により絞込。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useCompany } from '../contexts/CompanyContext.jsx'
import {
  canViewInventory,
  canAdjustInventory,
  assertCan,
} from '../lib/permissions.js'
import { ERP_COLLECTIONS } from '../lib/erp/collections.js'
import { inventoryDocId, validateInventory } from '../lib/erp/schema.js'
import { addAuditToBatch, buildRetryBlockedMessage } from '../lib/erp/auditLog.js'

const fmtNum = (n) => (Number(n) || 0).toLocaleString()

export default function ErpInventory() {
  const { profile } = useAuth()
  const { company } = useCompany()

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [warehouseFilter, setWarehouseFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [adjustTarget, setAdjustTarget] = useState(null)

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const q = query(
        collection(db, ERP_COLLECTIONS.Inventory),
        where('company', '==', company.key),
      )
      const snap = await getDocs(q)
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      setErr(e?.message || 'データ取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [company.key])

  const warehouses = useMemo(() => {
    return [...new Set(items.map((i) => i.warehouseId).filter(Boolean))].sort()
  }, [items])

  const filtered = useMemo(() => {
    let arr = items
    if (warehouseFilter) arr = arr.filter((i) => i.warehouseId === warehouseFilter)
    if (keyword) {
      const k = keyword.toLowerCase()
      arr = arr.filter((i) =>
        (i.productId || '').toLowerCase().includes(k)
        || (i.lotNumber || '').toLowerCase().includes(k)
      )
    }
    return arr.sort((a, b) => (a.productId || '').localeCompare(b.productId || ''))
  }, [items, warehouseFilter, keyword])

  const allowView = canViewInventory(profile)
  const allowAdjust = canAdjustInventory(profile)

  if (!allowView) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        この画面は admin / internal 権限のみ閲覧できます。
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">在庫（ERP）</h1>
          <p className="text-xs text-gray-500">
            {company.name}（{company.key}）— {filtered.length} 件 / 全 {items.length} 件
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
        >
          🔄 再取得
        </button>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        ⚠️ 在庫の手動調整は楽観ロック未実装（Phase 2 で transaction 化予定）。
        複数ユーザーが同時に同じロットを調整すると、最後の書き込みが勝ちます。
        通常は入庫・出荷画面経由で自動更新されます。
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={warehouseFilter}
            onChange={(e) => setWarehouseFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">全倉庫</option>
            {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="商品ID / ロット番号で検索"
            className="flex-1 min-w-[200px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{err}</div>
      )}

      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          在庫データがありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">商品ID</th>
                  <th className="px-3 py-2 text-left">ロット</th>
                  <th className="px-3 py-2 text-left">倉庫</th>
                  <th className="px-3 py-2 text-right">在庫数</th>
                  <th className="px-3 py-2 text-right">引当中</th>
                  <th className="px-3 py-2 text-right">利用可能</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((it) => {
                  const available = (it.qty || 0) - (it.reservedQty || 0)
                  return (
                    <tr key={it.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs">{it.productId}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{it.lotNumber || '—'}</td>
                      <td className="px-3 py-2">{it.warehouseId}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmtNum(it.qty)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{fmtNum(it.reservedQty)}</td>
                      <td className={`px-3 py-2 text-right font-medium ${available < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                        {fmtNum(available)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {allowAdjust ? (
                          <button
                            onClick={() => setAdjustTarget(it)}
                            className="text-xs text-indigo-600 hover:underline"
                          >
                            調整
                          </button>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
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

      {adjustTarget && (
        <InventoryAdjust
          inv={adjustTarget}
          profile={profile}
          onClose={() => setAdjustTarget(null)}
          onSaved={() => { setAdjustTarget(null); load() }}
        />
      )}
    </div>
  )
}

// ================================================================
// 手動調整モーダル
// ================================================================
function InventoryAdjust({ inv, profile, onClose, onSaved }) {
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!saving) return
    const handleKeyDown = (e) => { if (e.key === 'Escape') e.stopPropagation() }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [saving])
  const handleBackdropClose = () => { if (!saving) onClose() }

  const newQty = (Number(inv.qty) || 0) + (Number(delta) || 0)

  const handleSave = async () => {
    if (saving) return
    try { assertCan(canAdjustInventory, profile, { userMessage: '在庫調整権限がありません' }) }
    catch (e) { alert(e.message); return }

    const d = Number(delta)
    if (!Number.isFinite(d) || d === 0) { alert('増減数（非ゼロ）を入力してください'); return }
    if (newQty < 0) { alert('調整後の在庫数が負になります'); return }
    if (!reason.trim()) { alert('調整理由は必須です'); return }

    setSaving(true)
    try {
      assertCan(canAdjustInventory, profile, { userMessage: '在庫調整権限がありません' })

      const batch = writeBatch(db)
      const invRef = doc(db, ERP_COLLECTIONS.Inventory, inv.id)
      const before = { qty: inv.qty || 0, reservedQty: inv.reservedQty || 0, version: inv.version || 1 }
      const afterPartial = {
        qty: newQty,
        availableQty: newQty - (inv.reservedQty || 0),
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedBy: profile.uid,
        // version: 監査・将来拡張用。同時調整時の競合保護は未実装（Phase 2）
        version: (inv.version || 1) + 1,
      }
      batch.update(invRef, afterPartial)
      addAuditToBatch(batch, {
        collection: ERP_COLLECTIONS.Inventory,
        docId: inv.id,
        action: 'update',
        before,
        after: {
          qty: newQty,
          reservedQty: inv.reservedQty || 0,
          version: (inv.version || 1) + 1,
        },
        profile,
        reason: `手動調整 (${d >= 0 ? '+' : ''}${d}): ${reason.trim()}`,
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
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">在庫調整</h2>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg bg-gray-50 p-3 text-xs">
            <div>商品ID: <span className="font-mono">{inv.productId}</span></div>
            <div>ロット: {inv.lotNumber || '—'}</div>
            <div>倉庫: {inv.warehouseId}</div>
            <div>現在庫数: <span className="font-bold">{fmtNum(inv.qty)}</span></div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">増減数（+/- 可）</label>
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="例: -10 または 5"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <div className="mt-1 text-xs text-gray-500">
              調整後 → <span className={newQty < 0 ? 'text-red-600' : 'font-medium text-emerald-700'}>{fmtNum(newQty)}</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">調整理由 *（必須）</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="例: 棚卸差異、破損、ロス調整"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">キャンセル</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? '保存中...' : '調整を保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
