import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  collectionGroup,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  orderBy,
  query,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { fetchAllProducts } from '../lib/bcartApi.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import {
  canManageSalonProduct,
  canSyncBcartProducts,
  canBulkDeleteSalonProducts,
  assertCan,
} from '../lib/permissions.js'

const SKIN_TYPE_OPTIONS = ['乾燥', '敏感', '混合', '脂性', '普通', 'エイジング']
const CONCERN_OPTIONS = ['シミ', 'たるみ', 'シワ', '毛穴', 'ニキビ', 'くすみ', '赤み', '乾燥']

function fmtYen(n) {
  if (n == null) return '¥0'
  return '¥' + Number(n).toLocaleString()
}

export default function SalonProductsAdmin() {
  const { profile } = useAuth()
  const allowManage = canManageSalonProduct(profile)
  const allowSync = canSyncBcartProducts(profile)
  const allowBulkDelete = canBulkDeleteSalonProducts(profile)
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [filterBrand, setFilterBrand] = useState('VAVITTE') // 同期時のブランドフィルタ
  const [showCsvImport, setShowCsvImport] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  // productId -> { total, sold } の集計マップ
  const [recoStats, setRecoStats] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'salonProducts'), orderBy('name')))
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
      // インデックスなしで再取得
      try {
        const snap2 = await getDocs(collection(db, 'salonProducts'))
        setProducts(snap2.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e2) {
        console.error(e2)
      }
    } finally {
      setLoading(false)
    }
  }

  // 成約率集計：collectionGroup で recommendations を横断クエリ
  // Phase 1 は期間フィルタなし・全件集計
  const loadRecoStats = async () => {
    try {
      const snap = await getDocs(collectionGroup(db, 'recommendations'))
      const map = {}
      snap.docs.forEach((d) => {
        const data = d.data()
        const pid = data.productId
        if (!pid) return
        if (!map[pid]) map[pid] = { total: 0, sold: 0 }
        map[pid].total += 1
        if (data.status === 'sold') map[pid].sold += 1
      })
      setRecoStats(map)
    } catch (e) {
      // collectionGroup インデックスが未作成の場合や権限不足はログだけ残して画面は継続
      console.error('レコメンド集計失敗:', e)
      setRecoStats({})
    }
  }
  useEffect(() => { load(); loadRecoStats() }, [])

  // 選択トグル
  const toggleSelect = (id) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedIds(next)
  }
  const toggleSelectAll = () => {
    if (selectedIds.size === products.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(products.map((p) => p.id)))
  }

  // 一括削除
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    // 二重防御：admin のみ許可（UI側で非表示でも直接呼ばれ得る）
    try {
      assertCan(canBulkDeleteSalonProducts, profile)
    } catch (e) {
      alert(e.message); return
    }
    const targets = products.filter((p) => selectedIds.has(p.id))
    const names = targets.slice(0, 5).map((p) => `・${p.name}`).join('\n')
    const more = targets.length > 5 ? `\n…他${targets.length - 5}件` : ''
    if (!confirm(`以下の${targets.length}件を削除します。この操作は取り消せません。\n\n${names}${more}\n\n本当に削除しますか？`)) return

    setBulkDeleting(true)
    try {
      // 500件ずつ batch
      const ids = Array.from(selectedIds)
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(db)
        ids.slice(i, i + 400).forEach((id) => {
          batch.delete(doc(db, 'salonProducts', id))
        })
        await batch.commit()
      }
      setSelectedIds(new Set())
      load()
    } catch (e) {
      alert('削除失敗: ' + e.message)
    } finally {
      setBulkDeleting(false)
    }
  }

  // === Bカートから商品を同期 ===
  const handleSync = async () => {
    // 二重防御：admin のみ許可（破壊リスク高）
    try {
      assertCan(canSyncBcartProducts, profile)
    } catch (e) {
      alert(e.message); return
    }
    if (!confirm(`Bカートから「${filterBrand}」を含む商品を取得して、未登録分を salonProducts に追加します。\n\n※ 既存商品の肌タイプ・提案セリフは上書きしません。\n※ 価格は Bカート API に含まれないため後で手入力してください。\n\n続けますか？`)) return
    setSyncing(true)
    setSyncResult(null)
    try {
      // Bカート全商品取得
      const bcartProducts = await fetchAllProducts((done, total) => {
        setSyncResult({ phase: '取得中', done, total })
      })

      // ブランドフィルタ
      const filtered = filterBrand
        ? bcartProducts.filter((p) => (p.name || '').includes(filterBrand))
        : bcartProducts

      // 既存 salonProducts の bcartProductId マップ
      const existingSnap = await getDocs(collection(db, 'salonProducts'))
      const existingByBcartId = {}
      existingSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.bcartProductId) existingByBcartId[String(data.bcartProductId)] = { id: d.id, ...data }
      })

      let added = 0
      let updated = 0
      let skipped = 0

      // 400件ずつ batch
      for (let i = 0; i < filtered.length; i += 400) {
        const chunk = filtered.slice(i, i + 400)
        const batch = writeBatch(db)
        chunk.forEach((bp) => {
          const bcartId = String(bp.id)
          const existing = existingByBcartId[bcartId]
          if (existing) {
            // 既存：商品名と JAN だけ更新（admin が設定した skinTypes/script は触らない）
            const nameChanged = existing.name !== bp.name
            const janChanged = (existing.bcartMainNo || '') !== (bp.main_no || '')
            if (nameChanged || janChanged) {
              batch.update(doc(db, 'salonProducts', existing.id), {
                name: bp.name,
                bcartMainNo: bp.main_no || '',
                bcartCategoryId: bp.category_id || null,
                bcartCatchCopy: bp.catch_copy || '',
                updatedAt: serverTimestamp(),
              })
              updated++
            } else {
              skipped++
            }
          } else {
            // 新規：admin が後で価格・肌タイプ・セリフを補完
            const ref = doc(collection(db, 'salonProducts'))
            batch.set(ref, {
              name: bp.name,
              price: 0,
              bcartProductId: bcartId,
              bcartMainNo: bp.main_no || '',
              bcartCategoryId: bp.category_id || null,
              bcartCatchCopy: bp.catch_copy || '',
              skinTypes: [],
              concerns: [],
              suggestedScript: '',
              reason: '',
              active: false, // admin がレビュー後に公開
              syncedFromBcart: true,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
            added++
          }
        })
        await batch.commit()
      }

      setSyncResult({
        phase: '完了',
        total: filtered.length,
        added,
        updated,
        skipped,
        bcartTotal: bcartProducts.length,
      })
      load()
    } catch (e) {
      console.error(e)
      setSyncResult({ phase: 'エラー', error: e.message })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">サロン管理 — 店販商品マスタ</h1>
          <p className="mt-1 text-sm text-gray-500">
            サロンの「顧客管理 → おすすめ商品」で表示される商品を管理します
          </p>
        </div>
        <div className="flex items-center gap-2">
          {allowSync && (
            <>
              <input
                type="text"
                value={filterBrand}
                onChange={(e) => setFilterBrand(e.target.value)}
                placeholder="ブランド名フィルタ"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-32"
              />
              <button
                onClick={handleSync}
                disabled={syncing}
                className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                {syncing ? '同期中…' : '🔄 Bカート同期(API)'}
              </button>
              <button
                onClick={() => setShowCsvImport(true)}
                className="rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100"
              >
                📥 BカートCSV取込
              </button>
            </>
          )}
          {allowManage && (
            <button
              onClick={() => { setEditing(null); setShowForm(true) }}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              + 商品を追加
            </button>
          )}
          {!allowManage && !allowSync && (
            <span className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600">
              🔒 閲覧のみ
            </span>
          )}
        </div>
      </div>

      {/* 同期結果表示 */}
      {syncResult && (
        <div className={`rounded-xl border-2 p-4 text-sm ${
          syncResult.phase === 'エラー' ? 'border-red-300 bg-red-50 text-red-800'
          : syncResult.phase === '完了' ? 'border-green-300 bg-green-50 text-green-800'
          : 'border-blue-300 bg-blue-50 text-blue-800'
        }`}>
          {syncResult.phase === '取得中' && (
            <>📡 Bカートから取得中… {syncResult.done}/{syncResult.total}件</>
          )}
          {syncResult.phase === '完了' && (
            <>
              <div className="font-bold">✅ Bカート同期完了</div>
              <div className="mt-1 text-xs">
                Bカート商品: 全{syncResult.bcartTotal}件 / フィルタ後{syncResult.total}件 →
                <span className="ml-1 font-bold text-pink-700">新規{syncResult.added}件</span>、
                更新{syncResult.updated}件、変更なし{syncResult.skipped}件
              </div>
              <div className="mt-2 text-xs">
                ※ 新規追加分は「公開: 〇」になっていません。価格・肌タイプ・提案セリフを設定してから「公開」してください。
              </div>
            </>
          )}
          {syncResult.phase === 'エラー' && (
            <>
              <div className="font-bold">❌ 同期失敗</div>
              <div className="mt-1 text-xs">{syncResult.error}</div>
              <div className="mt-2 text-xs">
                Bカート API トークン（VITE_BCART_API_TOKEN）が設定されているか、本番では Cloud Functions プロキシが動作しているか確認してください。
              </div>
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">読み込み中…</div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
          商品が登録されていません。「+ 商品を追加」から登録してください。
        </div>
      ) : (
        <>
          {/* 選択時に出る一括操作バー（admin のみ） */}
          {allowBulkDelete && selectedIds.size > 0 && (
            <div className="sticky top-2 z-10 mb-2 flex items-center justify-between rounded-lg border-2 border-pink-300 bg-pink-50 p-3 shadow-md">
              <div className="text-sm font-bold text-pink-700">
                {selectedIds.size}件 選択中
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  選択解除
                </button>
                <button
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {bulkDeleting ? '削除中…' : `🗑 ${selectedIds.size}件を削除`}
                </button>
              </div>
            </div>
          )}
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                {allowBulkDelete && (
                  <th className="px-3 py-3 text-center w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && selectedIds.size === products.length}
                      ref={(el) => {
                        if (el) {
                          const isIndet = selectedIds.size > 0 && (selectedIds.size !== products.length)
                          el.indeterminate = isIndet
                        }
                      }}
                      onChange={toggleSelectAll}
                    />
                  </th>
                )}
                <th className="px-4 py-3 text-left">商品名</th>
                <th className="px-4 py-3 text-right">価格</th>
                <th className="px-4 py-3 text-left">対応肌タイプ</th>
                <th className="px-4 py-3 text-left">対応お悩み</th>
                <th className="px-4 py-3 text-center">公開</th>
                <th className="px-4 py-3 text-right">成約率</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) => (
                <tr key={p.id} className={`${selectedIds.has(p.id) ? 'bg-pink-50' : 'hover:bg-gray-50'}`}>
                  {allowBulkDelete && (
                    <td className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.id)}
                        onChange={() => toggleSelect(p.id)}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="font-medium">{p.name}</div>
                    {p.suggestedScript && (
                      <div className="mt-1 text-xs text-gray-500 truncate max-w-xs">💬 {p.suggestedScript}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{fmtYen(p.price)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(p.skinTypes || []).map((s) => (
                        <span key={s} className="rounded-full bg-pink-100 px-2 py-0.5 text-[10px] text-pink-700">{s}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(p.concerns || []).map((c) => (
                        <span key={c} className="rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] text-yellow-700">{c}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {p.active ? <span className="text-green-600">●</span> : <span className="text-gray-300">○</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const s = recoStats[p.id]
                      if (!s || s.total === 0) return <span className="text-xs text-gray-300">—</span>
                      const rate = Math.round((s.sold / s.total) * 100)
                      return (
                        <span className="text-xs text-gray-700">
                          {s.sold}/{s.total} <span className="text-pink-600 font-bold">({rate}%)</span>
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {allowManage ? (
                      <button onClick={() => { setEditing(p); setShowForm(true) }}
                        className="text-xs text-pink-600 hover:underline">編集</button>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {showForm && (
        <ProductForm
          editing={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
        />
      )}

      {showCsvImport && (
        <BcartCsvImportModal
          filterBrand={filterBrand}
          onClose={() => setShowCsvImport(false)}
          onDone={() => { setShowCsvImport(false); load() }}
        />
      )}
    </div>
  )
}

// ============================
// Bカート商品CSV取込モーダル（Shift-JIS対応・上代を価格採用）
// ============================
function parseBcartCsv(text) {
  const rows = []
  let row = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') q = false
      else cur += c
    } else {
      if (c === '"') q = true
      else if (c === ',') { row.push(cur); cur = '' }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
      else if (c !== '\r') cur += c
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

// Bカート商品CSVの列インデックス
const COL = {
  DELETE_FLAG: 0,
  BCART_ID: 1,
  NAME: 2,
  CATCH_COPY: 4,
  CATEGORY_ID: 5,
  SIZE: 11,
  JAN: 41,
  WHOLESALE_PRICE: 44, // 上代
  UNIT_PRICE: 51,      // 単価
  SPECIAL_PRICE: 53,   // 特別価格
}

function BcartCsvImportModal({ filterBrand: defaultBrand, onClose, onDone }) {
  const { profile } = useAuth()
  const [filterBrand, setFilterBrand] = useState(defaultBrand || 'VAVITTE')
  const [allRows, setAllRows] = useState([])
  const [filtered, setFiltered] = useState([])
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')

  const handleFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setError('')
    setProgress(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const buf = ev.target.result
        // Shift-JIS デコード（Bカート標準）
        const text = new TextDecoder('shift-jis').decode(buf)
        const rows = parseBcartCsv(text)
        if (rows.length < 2) { setError('CSVが空、または見出しのみです'); return }
        // 1行目はヘッダなので除外、削除フラグ立っている行も除外
        const data = rows.slice(1).filter((r) => r[COL.DELETE_FLAG] !== '1' && r[COL.NAME])
        setAllRows(data)
      } catch (err) {
        console.error(err)
        setError('CSV解析失敗: ' + err.message)
      }
    }
    reader.readAsArrayBuffer(f)
  }

  // フィルタ適用
  useEffect(() => {
    if (!allRows.length) { setFiltered([]); return }
    const f = filterBrand
      ? allRows.filter((r) => (r[COL.NAME] || '').includes(filterBrand))
      : allRows
    setFiltered(f)
  }, [allRows, filterBrand])

  const handleImport = async () => {
    if (!filtered.length) return
    // 二重防御：CSV取込も破壊リスクが高いため admin のみ
    try {
      assertCan(canSyncBcartProducts, profile)
    } catch (e) {
      setError(e.message); return
    }
    if (!confirm(`${filtered.length}件の商品を salonProducts に取込みます。\n\n価格は「上代」を採用、空なら単価にフォールバック。\n既存商品の肌タイプ・提案セリフは保護されます。\n\n続けますか？`)) return

    setImporting(true)
    setProgress({ phase: '既存データ確認中…', done: 0, total: filtered.length })

    try {
      // 既存マップ
      const existingSnap = await getDocs(collection(db, 'salonProducts'))
      const existingByBcartId = {}
      existingSnap.docs.forEach((d) => {
        const data = d.data()
        if (data.bcartProductId) existingByBcartId[String(data.bcartProductId)] = { id: d.id, ...data }
      })

      let added = 0, updated = 0, skipped = 0

      for (let i = 0; i < filtered.length; i += 400) {
        const chunk = filtered.slice(i, i + 400)
        const batch = writeBatch(db)
        chunk.forEach((row) => {
          const bcartId = String(row[COL.BCART_ID] || '').trim()
          if (!bcartId) { skipped++; return }
          const name = (row[COL.NAME] || '').trim()
          const wholesale = Number(row[COL.WHOLESALE_PRICE]) || 0
          const unit = Number(row[COL.UNIT_PRICE]) || 0
          const price = wholesale > 0 ? wholesale : unit // 上代優先、空なら単価
          const jan = (row[COL.JAN] || '').trim()
          const catchCopy = (row[COL.CATCH_COPY] || '').trim()
          const categoryId = row[COL.CATEGORY_ID] ? Number(row[COL.CATEGORY_ID]) : null
          const size = (row[COL.SIZE] || '').trim()

          const existing = existingByBcartId[bcartId]
          if (existing) {
            // 既存：価格・名前・JAN・キャッチだけ更新（肌タイプ・セリフは保護）
            batch.update(doc(db, 'salonProducts', existing.id), {
              name,
              price,
              bcartMainNo: jan,
              bcartCategoryId: categoryId,
              bcartCatchCopy: catchCopy,
              bcartSize: size,
              updatedAt: serverTimestamp(),
            })
            updated++
          } else {
            // 新規：active: false（admin が肌タイプ/セリフ設定後に公開）
            const ref = doc(collection(db, 'salonProducts'))
            batch.set(ref, {
              name,
              price,
              bcartProductId: bcartId,
              bcartMainNo: jan,
              bcartCategoryId: categoryId,
              bcartCatchCopy: catchCopy,
              bcartSize: size,
              skinTypes: [],
              concerns: [],
              suggestedScript: '',
              reason: '',
              active: false,
              syncedFromBcart: true,
              syncSource: 'csv',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            })
            added++
          }
        })
        await batch.commit()
        setProgress({ phase: '取込中…', done: Math.min(i + 400, filtered.length), total: filtered.length })
      }

      setProgress({ phase: '完了', added, updated, skipped, total: filtered.length })
    } catch (e) {
      console.error(e)
      setError('取込失敗: ' + e.message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">📥 Bカート商品マスタ CSV取込</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
            <div className="font-bold">取込仕様</div>
            <div className="mt-1">
              ・Bカート管理画面 → 商品マスタ → CSV出力 のファイルをそのまま使えます<br/>
              ・文字コード Shift-JIS 自動判定<br/>
              ・<b>価格は「上代」を採用</b>、空なら「単価」にフォールバック<br/>
              ・「削除フラグ」が立っている行はスキップ<br/>
              ・既存商品（Bカート商品IDで判定）の肌タイプ・提案セリフは<b>絶対に上書きしません</b><br/>
              ・新規取込分は <b>非公開</b> 状態で入ります（肌タイプ・セリフ設定後に公開してください）
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">CSVファイル</label>
            <input type="file" accept=".csv" onChange={handleFile}
              className="mt-1 block w-full text-sm" />
          </div>

          {allRows.length > 0 && (
            <div>
              <label className="text-xs font-medium text-gray-700">
                ブランド名フィルタ（商品名にこの文字を含むものだけ取込）
              </label>
              <input type="text" value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)}
                placeholder="空にすると全商品"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <div className="mt-1 text-xs text-gray-500">
                CSV全{allRows.length}件中、フィルタ後 <span className="font-bold text-pink-700">{filtered.length}件</span> が対象
              </div>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="rounded-lg border border-gray-200 p-3">
              <div className="text-sm font-medium text-gray-700">プレビュー（最初の5件）</div>
              <table className="mt-2 w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left">BカートID</th>
                    <th className="px-2 py-1 text-left">商品名</th>
                    <th className="px-2 py-1 text-right">価格(上代)</th>
                    <th className="px-2 py-1 text-left">JAN</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 5).map((r, i) => {
                    const wholesale = Number(r[COL.WHOLESALE_PRICE]) || 0
                    const unit = Number(r[COL.UNIT_PRICE]) || 0
                    const price = wholesale > 0 ? wholesale : unit
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 font-mono">{r[COL.BCART_ID]}</td>
                        <td className="px-2 py-1">{(r[COL.NAME] || '').substring(0, 50)}</td>
                        <td className="px-2 py-1 text-right">¥{price.toLocaleString()}</td>
                        <td className="px-2 py-1 font-mono">{r[COL.JAN]}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>
          )}

          {progress && (
            <div className={`rounded-lg p-3 text-sm ${
              progress.phase === '完了' ? 'border border-green-300 bg-green-50 text-green-800'
              : 'border border-blue-300 bg-blue-50 text-blue-800'
            }`}>
              {progress.phase === '完了' ? (
                <>
                  <div className="font-bold">✅ 取込完了</div>
                  <div className="mt-1 text-xs">
                    対象{progress.total}件 → <b className="text-pink-700">新規{progress.added}件</b>、更新{progress.updated}件、スキップ{progress.skipped}件
                  </div>
                  <div className="mt-2 text-xs">
                    新規取込分は非公開状態です。商品をクリックして肌タイプ・お悩み・提案セリフを設定後、「サロンに公開する」を ✓ にして保存してください。
                  </div>
                </>
              ) : (
                <>{progress.phase} {progress.done != null && `(${progress.done}/${progress.total})`}</>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={importing}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700">
            {progress?.phase === '完了' ? '閉じる' : 'キャンセル'}
          </button>
          {progress?.phase === '完了' && (
            <button onClick={onDone}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700">
              一覧を更新
            </button>
          )}
          {!progress?.phase || progress.phase !== '完了' ? (
            <button onClick={handleImport} disabled={!filtered.length || importing}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50">
              {importing ? '取込中…' : `${filtered.length}件を取込`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ProductForm({ editing, onClose, onSaved }) {
  const { profile } = useAuth()
  const isEdit = !!editing
  const [name, setName] = useState(editing?.name || '')
  const [price, setPrice] = useState(editing?.price || '')
  const [skinTypes, setSkinTypes] = useState(editing?.skinTypes || [])
  const [concerns, setConcerns] = useState(editing?.concerns || [])
  const [suggestedScript, setSuggestedScript] = useState(editing?.suggestedScript || '')
  const [reason, setReason] = useState(editing?.reason || '')
  const [active, setActive] = useState(editing?.active ?? true)
  const [bcartProductId, setBcartProductId] = useState(editing?.bcartProductId || '')
  const [saving, setSaving] = useState(false)

  const toggle = (arr, setArr, val) => {
    setArr(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val])
  }

  const handleSave = async () => {
    if (!name.trim()) { alert('商品名は必須です'); return }
    // 二重防御：通常CRUDは admin/staff のみ
    try {
      assertCan(canManageSalonProduct, profile)
    } catch (e) {
      alert(e.message); return
    }
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        price: Number(price) || 0,
        skinTypes,
        concerns,
        suggestedScript: suggestedScript.trim(),
        reason: reason.trim(),
        active,
        bcartProductId: bcartProductId.trim(),
        updatedAt: serverTimestamp(),
      }
      if (isEdit) {
        await updateDoc(doc(db, 'salonProducts', editing.id), data)
      } else {
        await addDoc(collection(db, 'salonProducts'), {
          ...data,
          createdAt: serverTimestamp(),
        })
      }
      onSaved()
    } catch (e) {
      console.error('salonProducts 保存失敗:', e)
      alert('保存失敗: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!isEdit) return
    // 二重防御：単体削除も admin/staff のみ（一括削除は admin のみで別権限）
    try {
      assertCan(canManageSalonProduct, profile)
    } catch (e) {
      alert(e.message); return
    }
    if (!confirm(`「${editing.name}」を削除しますか？`)) return
    setSaving(true)
    try {
      await deleteDoc(doc(db, 'salonProducts', editing.id))
      onSaved()
    } catch (e) {
      console.error('salonProducts 削除失敗:', e)
      alert('削除失敗: ' + e.message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{isEdit ? '商品を編集' : '商品を追加'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-gray-700">商品名 *</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="例: ボンバークリーム"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">価格</label>
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">Bカート商品ID（任意）</label>
              <input value={bcartProductId} onChange={(e) => setBcartProductId(e.target.value)}
                placeholder="将来の自動連動用"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">対応する肌タイプ（複数選択可）</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {SKIN_TYPE_OPTIONS.map((t) => (
                <button key={t} type="button" onClick={() => toggle(skinTypes, setSkinTypes, t)}
                  className={`rounded-full px-3 py-1 text-xs ${skinTypes.includes(t) ? 'bg-pink-600 text-white' : 'border border-gray-300 bg-white text-gray-700'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">対応するお悩み（複数選択可）</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {CONCERN_OPTIONS.map((t) => (
                <button key={t} type="button" onClick={() => toggle(concerns, setConcerns, t)}
                  className={`rounded-full px-3 py-1 text-xs ${concerns.includes(t) ? 'bg-pink-600 text-white' : 'border border-gray-300 bg-white text-gray-700'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">
              提案セリフ（サロンが顧客に伝える文言）
              <span className="ml-2 text-pink-600">★店販成約率を上げる核</span>
            </label>
            <textarea value={suggestedScript} onChange={(e) => setSuggestedScript(e.target.value)}
              rows={2}
              placeholder="例: {name}様の乾燥には、ボンバークリームのセラミドが効きます。1本で2ヶ月もちますよ。"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <div className="mt-1 text-[10px] text-gray-500">※ <code>{'{name}'}</code> はお客様の名前に自動置換されます</div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700">推薦理由（社内メモ）</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="例: セラミド配合・しっとり系"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>

          <div className="flex items-center gap-2">
            <input type="checkbox" id="active" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <label htmlFor="active" className="text-sm">サロンに公開する</label>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <div>
            {isEdit && (
              <button onClick={handleDelete} disabled={saving}
                className="text-sm text-red-600 hover:underline">削除</button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700">キャンセル</button>
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
