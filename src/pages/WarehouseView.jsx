import { useEffect, useState } from 'react'
import {
  collection, doc, getDocs, getDoc, orderBy,
  query, serverTimestamp, setDoc, addDoc,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'

const ALERT_THRESHOLD_DEFAULT = 10

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

const BADGE_PALETTE = [
  'bg-purple-100 text-purple-700', 'bg-blue-100 text-blue-700',
  'bg-pink-100 text-pink-700', 'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
]

function badgeColor(name, list) {
  const idx = list.indexOf(name)
  return idx < 0 ? 'bg-gray-100 text-gray-600' : BADGE_PALETTE[idx % BADGE_PALETTE.length]
}

export default function WarehouseView() {
  const [allProducts, setAllProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [warehouses, setWarehouses] = useState([])
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [selectedWh, setSelectedWh] = useState('')
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [sortKey, setSortKey] = useState('no')
  const [sortAsc, setSortAsc] = useState(true)

  // 選択商品
  const [selected, setSelected] = useState(null)
  const [history, setHistory] = useState([])
  const [histLoading, setHistLoading] = useState(false)

  // 入出庫
  const [ioType, setIoType] = useState('in')
  const [ioQty, setIoQty] = useState('')
  const [ioNote, setIoNote] = useState('')
  const [saving, setSaving] = useState(false)

  // 倉庫移動
  const [transferTo, setTransferTo] = useState('')
  const [transferQty, setTransferQty] = useState('')
  const [transferNote, setTransferNote] = useState('')

  // タブ
  const [rightTab, setRightTab] = useState('io')

  // 全倉庫の履歴（倉庫全体ログ）
  const [whHistory, setWhHistory] = useState([])
  const [whHistLoading, setWhHistLoading] = useState(false)

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    try {
      const [masterSnap, prodSnap] = await Promise.all([
        getDoc(doc(db, 'inventoryMasters', 'config')),
        getDocs(query(collection(db, 'products'), orderBy('no', 'asc'))),
      ])
      const m = masterSnap.exists() ? masterSnap.data() : {}
      const whs = m.warehouses || ['本社', '外部倉庫A', '外部倉庫B']
      setWarehouses(whs)
      setBrands(m.brands || [])
      setCategories(m.categories || [])
      if (whs.length > 0 && !selectedWh) setSelectedWh(whs[0])
      setAllProducts(prodSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  // 倉庫切り替え時
  useEffect(() => {
    if (selectedWh) { setSelected(null); loadWhHistory() }
  }, [selectedWh])

  // 倉庫全体の履歴
  const loadWhHistory = async () => {
    setWhHistLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'stockHistory'), orderBy('createdAt', 'desc')))
      setWhHistory(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .filter((h) => h.warehouse === selectedWh || h.warehouseFrom === selectedWh || h.warehouseTo === selectedWh)
          .slice(0, 100)
      )
    } catch (e) { console.error(e) }
    finally { setWhHistLoading(false) }
  }

  // 商品の履歴
  const loadHistory = async (productId) => {
    setHistLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'stockHistory'), orderBy('createdAt', 'desc')))
      setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((h) => h.productId === productId).slice(0, 50))
    } catch (e) { console.error(e) }
    finally { setHistLoading(false) }
  }

  // この倉庫の商品
  const whProducts = allProducts.filter((p) => p.warehouse === selectedWh)

  const filtered = whProducts
    .filter((p) => !brandFilter || p.brand === brandFilter)
    .filter((p) => !catFilter || p.category === catFilter)
    .filter((p) => {
      if (!search) return true
      const s = search.toLowerCase()
      return p.productName?.toLowerCase().includes(s) || p.volume?.toLowerCase().includes(s)
    })
    .sort((a, b) => {
      let cmp = 0
      if (sortKey === 'no') cmp = (a.no || 0) - (b.no || 0)
      else if (sortKey === 'name') cmp = (a.productName || '').localeCompare(b.productName || '', 'ja')
      else if (sortKey === 'stock') cmp = (a.stock || 0) - (b.stock || 0)
      else if (sortKey === 'brand') cmp = (a.brand || '').localeCompare(b.brand || '', 'ja')
      return sortAsc ? cmp : -cmp
    })

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'no') }
  }
  const sortIcon = (key) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  const selectProduct = (p) => { setSelected(p); setRightTab('io'); loadHistory(p.id) }

  // 入出庫
  const handleIO = async () => {
    if (!selected || !ioQty) return
    const qty = parseInt(ioQty)
    if (isNaN(qty) || qty <= 0) { alert('数量を正しく入力してください'); return }
    const change = ioType === 'in' ? qty : -qty
    const newStock = (selected.stock || 0) + change
    if (newStock < 0) { alert('在庫数がマイナスになります'); return }
    setSaving(true)
    try {
      await setDoc(doc(db, 'products', selected.id), { stock: newStock, updatedAt: serverTimestamp() }, { merge: true })
      await addDoc(collection(db, 'stockHistory'), {
        productId: selected.id, productName: selected.productName,
        type: ioType, quantity: qty, stockBefore: selected.stock || 0, stockAfter: newStock,
        warehouse: selectedWh, note: ioNote.trim(), createdAt: serverTimestamp(),
      })
      setAllProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, stock: newStock } : p)))
      setSelected((prev) => prev ? { ...prev, stock: newStock } : null)
      setIoQty(''); setIoNote('')
      loadHistory(selected.id)
      loadWhHistory()
    } catch (e) { alert('処理失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 倉庫移動
  const handleTransfer = async () => {
    if (!selected || !transferTo || !transferQty) return
    if (transferTo === selectedWh) { alert('同じ倉庫です'); return }
    const qty = parseInt(transferQty)
    if (isNaN(qty) || qty <= 0) { alert('数量を正しく入力してください'); return }
    if (qty > (selected.stock || 0)) { alert('在庫数を超えています'); return }
    setSaving(true)
    try {
      if (qty === (selected.stock || 0)) {
        await setDoc(doc(db, 'products', selected.id), { warehouse: transferTo, updatedAt: serverTimestamp() }, { merge: true })
        setAllProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, warehouse: transferTo } : p)))
        setSelected(null)
      }
      await addDoc(collection(db, 'stockHistory'), {
        productId: selected.id, productName: selected.productName,
        type: 'transfer', quantity: qty,
        stockBefore: selected.stock || 0, stockAfter: selected.stock || 0,
        warehouseFrom: selectedWh, warehouseTo: transferTo, warehouse: transferTo,
        note: transferNote.trim() || `${selectedWh} → ${transferTo}`,
        createdAt: serverTimestamp(),
      })
      setTransferTo(''); setTransferQty(''); setTransferNote('')
      loadHistory(selected?.id)
      loadWhHistory()
    } catch (e) { alert('移動失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  const totalInWh = whProducts.length
  const totalStock = whProducts.reduce((s, p) => s + (p.stock || 0), 0)
  const zeroStock = whProducts.filter((p) => p.stock === 0).length
  const lowStock = whProducts.filter((p) => p.stock > 0 && p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT)).length

  const fmtTime = (ts) => {
    if (!ts) return '—'
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-gray-900">倉庫管理</h1>

      {/* 倉庫タブ */}
      <div className="mb-4 flex flex-wrap gap-2">
        {warehouses.map((wh) => {
          const cnt = allProducts.filter((p) => p.warehouse === wh).length
          return (
            <button key={wh} onClick={() => setSelectedWh(wh)}
              className={`rounded-xl px-5 py-3 text-sm font-medium transition-colors ${
                selectedWh === wh
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}>
              {wh}
              <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
                selectedWh === wh ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                {cnt}
              </span>
            </button>
          )
        })}
      </div>

      {/* サマリー */}
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
          <div className="text-xs text-gray-500">商品数</div>
          <div className="text-xl font-bold text-gray-900">{totalInWh}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
          <div className="text-xs text-gray-500">総在庫</div>
          <div className="text-xl font-bold text-indigo-600">{fmtNum(totalStock)}</div>
        </div>
        {zeroStock > 0 && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-center">
            <div className="text-xs text-red-500">在庫切れ</div>
            <div className="text-xl font-bold text-red-600">{zeroStock}</div>
          </div>
        )}
        {lowStock > 0 && (
          <div className="rounded-xl border border-yellow-200 bg-yellow-50 px-5 py-3 text-center">
            <div className="text-xs text-yellow-600">残りわずか</div>
            <div className="text-xl font-bold text-yellow-600">{lowStock}</div>
          </div>
        )}
      </div>

      {/* 検索・フィルタ */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="text" placeholder="商品名で検索..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
        {brands.length > 0 && (
          <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
            <option value="">全ブランド</option>
            {brands.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        {categories.length > 0 && (
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
            <option value="">全分類</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {(brandFilter || catFilter) && (
          <button onClick={() => { setBrandFilter(''); setCatFilter('') }}
            className="text-sm text-indigo-600 hover:underline">フィルタ解除</button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：在庫一覧 */}
        <div className="lg:col-span-2">
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white" style={{ maxHeight: 'calc(100vh - 340px)' }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('no')}>NO{sortIcon('no')}</th>
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('name')}>商品名{sortIcon('name')}</th>
                  <th className="px-2 py-2">容量</th>
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('brand')}>ブランド{sortIcon('brand')}</th>
                  <th className="px-2 py-2">分類</th>
                  <th className="cursor-pointer px-2 py-2 text-right hover:text-gray-900" onClick={() => handleSort('stock')}>在庫{sortIcon('stock')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const isZero = p.stock === 0
                  const isLow = p.stock > 0 && p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT)
                  return (
                    <tr key={p.id} onClick={() => selectProduct(p)}
                      className={`cursor-pointer border-b border-gray-50 ${
                        selected?.id === p.id ? 'bg-indigo-50'
                        : isZero ? 'bg-red-50 hover:bg-red-100'
                        : isLow ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-50'}`}>
                      <td className="px-2 py-2 text-xs text-gray-400">{p.no}</td>
                      <td className="px-2 py-2 font-medium text-gray-900">{p.productName}</td>
                      <td className="px-2 py-2 text-xs text-gray-500">{p.volume || ''}</td>
                      <td className="px-2 py-2">
                        {p.brand && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor(p.brand, brands)}`}>{p.brand}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500">{p.category || ''}</td>
                      <td className="px-2 py-2 text-right">
                        <span className={`font-bold ${isZero ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-gray-900'}`}>
                          {fmtNum(p.stock)}
                        </span>
                        {isZero && <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-600">切れ</span>}
                        {isLow && <span className="ml-1 rounded bg-yellow-100 px-1 py-0.5 text-[10px] text-yellow-700">少</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-gray-400">この倉庫に商品がありません</div>
            )}
          </div>
          <div className="mt-2 text-xs text-gray-400">{filtered.length} / {totalInWh} 件表示</div>

          {/* 倉庫全体の履歴 */}
          <div className="mt-4 rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-2">
              <span className="text-xs font-bold text-gray-600">{selectedWh} の入出庫・移動ログ</span>
            </div>
            <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
              {whHistLoading ? (
                <div className="py-4 text-center text-xs text-gray-400">読み込み中...</div>
              ) : whHistory.length === 0 ? (
                <div className="py-4 text-center text-xs text-gray-400">履歴なし</div>
              ) : (
                whHistory.slice(0, 30).map((h) => (
                  <div key={h.id} className="flex items-center justify-between border-b border-gray-50 px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        h.type === 'in' ? 'bg-green-100 text-green-700'
                        : h.type === 'out' ? 'bg-orange-100 text-orange-700'
                        : 'bg-indigo-100 text-indigo-700'}`}>
                        {h.type === 'in' ? '入庫' : h.type === 'out' ? '出庫' : '移動'}
                      </span>
                      <span className="text-xs font-medium text-gray-700">{h.productName}</span>
                      {h.type === 'transfer' ? (
                        <span className="text-xs text-gray-500">{h.warehouseFrom} → {h.warehouseTo} ({h.quantity}個)</span>
                      ) : (
                        <span className="text-xs text-gray-500">{h.type === 'in' ? '+' : '-'}{h.quantity} → {fmtNum(h.stockAfter)}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-gray-400">{fmtTime(h.createdAt)}</div>
                      {h.note && h.type !== 'transfer' && <div className="text-[10px] text-gray-500">{h.note}</div>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* 右パネル */}
        <div className="lg:col-span-1">
          {selected ? (
            <div>
              {/* 商品情報 */}
              <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                <div className="text-lg font-bold text-gray-900">{selected.productName}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {selected.brand && (
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor(selected.brand, brands)}`}>{selected.brand}</span>
                  )}
                  {selected.category && (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{selected.category}</span>
                  )}
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-indigo-600">{fmtNum(selected.stock)}</span>
                  <span className="text-sm text-gray-500">{selected.volume}</span>
                </div>
              </div>

              {/* タブ */}
              <div className="mb-3 flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                {[{ key: 'io', label: '入出庫' }, { key: 'transfer', label: '他倉庫へ移動' }, { key: 'history', label: '履歴' }].map((t) => (
                  <button key={t.key} onClick={() => setRightTab(t.key)}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                      rightTab === t.key ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* 入出庫 */}
              {rightTab === 'io' && (
                <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                  <div className="mb-3 flex gap-2">
                    <button onClick={() => setIoType('in')}
                      className={`flex-1 rounded-lg py-2 text-sm font-medium ${ioType === 'in' ? 'bg-green-600 text-white' : 'border border-gray-300 text-gray-600'}`}>入庫</button>
                    <button onClick={() => setIoType('out')}
                      className={`flex-1 rounded-lg py-2 text-sm font-medium ${ioType === 'out' ? 'bg-orange-500 text-white' : 'border border-gray-300 text-gray-600'}`}>出庫</button>
                  </div>
                  <input type="number" min="1" placeholder="数量" value={ioQty} onChange={(e) => setIoQty(e.target.value)}
                    className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                  <input type="text" placeholder="備考（入荷、出荷先など）" value={ioNote} onChange={(e) => setIoNote(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleIO()}
                    className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                  <button onClick={handleIO} disabled={saving || !ioQty}
                    className={`w-full rounded-lg py-2 text-sm font-bold text-white ${ioType === 'in' ? 'bg-green-600 hover:bg-green-700' : 'bg-orange-500 hover:bg-orange-600'} disabled:opacity-40`}>
                    {saving ? '処理中...' : ioType === 'in' ? '入庫する' : '出庫する'}
                  </button>
                </div>
              )}

              {/* 移動 */}
              {rightTab === 'transfer' && (
                <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                  <div className="mb-2 text-xs text-gray-500">
                    現在: <span className="font-medium text-gray-900">{selectedWh}</span>
                  </div>
                  <label className="mb-1 block text-xs text-gray-500">移動先</label>
                  <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}
                    className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
                    <option value="">-- 移動先を選択 --</option>
                    {warehouses.filter((w) => w !== selectedWh).map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <input type="number" min="1" max={selected.stock || 0} placeholder="移動数量"
                    value={transferQty} onChange={(e) => setTransferQty(e.target.value)}
                    className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                  <input type="text" placeholder="備考（任意）" value={transferNote} onChange={(e) => setTransferNote(e.target.value)}
                    className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                  <button onClick={handleTransfer} disabled={saving || !transferTo || !transferQty}
                    className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                    {saving ? '処理中...' : '移動する'}
                  </button>
                </div>
              )}

              {/* 商品履歴 */}
              {rightTab === 'history' && (
                <div className="rounded-xl border border-gray-200 bg-white" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                  <div className="sticky top-0 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-bold text-gray-600">
                    {selected.productName} の履歴
                  </div>
                  {histLoading ? (
                    <div className="py-6 text-center text-xs text-gray-400">読み込み中...</div>
                  ) : history.length === 0 ? (
                    <div className="py-6 text-center text-xs text-gray-400">履歴なし</div>
                  ) : (
                    history.map((h) => (
                      <div key={h.id} className="flex items-center justify-between border-b border-gray-50 px-4 py-2">
                        <div>
                          <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            h.type === 'in' ? 'bg-green-100 text-green-700'
                            : h.type === 'out' ? 'bg-orange-100 text-orange-700'
                            : 'bg-indigo-100 text-indigo-700'}`}>
                            {h.type === 'in' ? '入庫' : h.type === 'out' ? '出庫' : '移動'}
                          </span>
                          {h.type === 'transfer' ? (
                            <span className="text-xs text-gray-700">{h.warehouseFrom} → {h.warehouseTo} ({h.quantity}個)</span>
                          ) : (
                            <>
                              <span className="text-sm font-medium">{h.type === 'in' ? '+' : '-'}{h.quantity}</span>
                              <span className="ml-2 text-xs text-gray-400">→ {fmtNum(h.stockAfter)}</span>
                            </>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] text-gray-400">{fmtTime(h.createdAt)}</div>
                          {h.note && h.type !== 'transfer' && <div className="text-[10px] text-gray-500">{h.note}</div>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
              左の一覧から商品を選択してください
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
