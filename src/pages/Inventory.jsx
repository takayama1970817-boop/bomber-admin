import { useEffect, useState } from 'react'
import {
  collection, doc, getDocs, deleteDoc, orderBy, getDoc,
  query, where, serverTimestamp, setDoc, writeBatch, addDoc, Timestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase.js'

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

const ALERT_THRESHOLD_DEFAULT = 10
const MASTER_DOC = 'inventoryMasters/config'

// デフォルト（Firestoreに未保存のとき使う初期値）
const DEFAULT_BRANDS = ['VAVITTE', 'Peel System', 'Absolute', 'WUVIC', 'その他']
const DEFAULT_CATEGORIES = ['店販化粧品', '業務用化粧品', '資材', 'その他']
const DEFAULT_WAREHOUSES = ['本社', '外部倉庫A', '外部倉庫B']

// バッジ色（自動割り当て用パレット）
const BADGE_PALETTE = [
  'bg-purple-100 text-purple-700', 'bg-blue-100 text-blue-700',
  'bg-pink-100 text-pink-700', 'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-700',
  'bg-violet-100 text-violet-700', 'bg-lime-100 text-lime-700',
  'bg-fuchsia-100 text-fuchsia-700', 'bg-sky-100 text-sky-700',
]
const WH_PALETTE = [
  'bg-indigo-100 text-indigo-700', 'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700', 'bg-orange-100 text-orange-700',
  'bg-cyan-100 text-cyan-700', 'bg-slate-100 text-slate-700',
]

function badgeColor(name, list, palette) {
  const idx = list.indexOf(name)
  if (idx < 0) return 'bg-gray-100 text-gray-600'
  return palette[idx % palette.length]
}

function SelectField({ label, value, onChange, options, placeholder }) {
  return (
    <>
      {label && <label className="mb-1 block text-xs text-gray-500">{label}</label>}
      <select value={value} onChange={onChange}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </>
  )
}

function TextField({ label, value, onChange, type = 'text', ...rest }) {
  return (
    <>
      {label && <label className="mb-1 block text-xs text-gray-500">{label}</label>}
      <input type={type} value={value} onChange={onChange}
        className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" {...rest} />
    </>
  )
}

// ========================================
// Bカート在庫同期モーダル
// ========================================
function BcartSyncModal({ isOpen, onClose, products }) {
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState(null)
  const [bcartSettings, setBcartSettings] = useState(null)
  const [loadingSettings, setLoadingSettings] = useState(true)

  useEffect(() => {
    if (!isOpen) return
    setResults(null)
    setProgress('')
    ;(async () => {
      setLoadingSettings(true)
      try {
        const compDoc = await getDoc(doc(db, 'settings', 'company'))
        if (compDoc.exists()) {
          const d = compDoc.data()
          setBcartSettings({
            domain: d.bcartDomain || '',
            apikey: d.bcartApiKey || '',
            threshold: d.bcartThreshold ?? 5,
            mapping: d.bcartMapping || 'code',
          })
        } else {
          setBcartSettings(null)
        }
      } catch (e) {
        console.error('設定読み込みエラー:', e)
      } finally {
        setLoadingSettings(false)
      }
    })()
  }, [isOpen])

  const handleSync = async () => {
    if (!bcartSettings?.domain || !bcartSettings?.apikey) {
      alert('Bカート連携設定が未設定です。基本設定から設定してください。')
      return
    }

    setSyncing(true)
    setProgress('在庫データを準備中...')
    try {
      // 全商品を同期対象として準備
      const items = products.map((p) => ({
        code: p.no || p.sku || '',
        bcart_id: p.bcartId || null,
        stock: p.stock || 0,
        name: p.productName || '',
        is_low: p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT),
      })).filter((it) => it.code || it.bcart_id)

      if (items.length === 0) {
        alert('同期対象の商品がありません（品番またはBカートIDが設定されている商品が必要です）')
        setSyncing(false)
        return
      }

      setProgress(`${items.length}件の商品を同期中...`)

      const syncFn = httpsCallable(functions, 'syncBcartInventory')
      const result = await syncFn({
        domain: bcartSettings.domain,
        apikey: bcartSettings.apikey,
        items,
        threshold: bcartSettings.threshold,
        mapping: bcartSettings.mapping,
      })

      setResults(result.data)
      setProgress('')
    } catch (e) {
      console.error('Bカート同期エラー:', e)
      alert('同期エラー: ' + (e.message || '不明なエラー'))
      setProgress('')
    } finally {
      setSyncing(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">🔄 Bカート在庫同期</h2>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100">✕</button>
        </div>

        {loadingSettings ? (
          <div className="py-8 text-center text-sm text-gray-400">設定を読み込み中...</div>
        ) : !bcartSettings?.domain || !bcartSettings?.apikey ? (
          <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-5 text-center">
            <div className="mb-2 text-2xl">⚠️</div>
            <p className="mb-2 text-sm font-medium text-yellow-800">Bカート連携が未設定です</p>
            <p className="text-xs text-yellow-600">
              基本設定 → Bカート連携設定 からドメインとAPIキーを設定してください。
            </p>
          </div>
        ) : (
          <>
            {/* 接続情報 */}
            <div className="mb-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
              <div className="flex gap-4">
                <span>ドメイン: <span className="font-medium text-gray-700">{bcartSettings.domain}.bcart.jp</span></span>
                <span>マッピング: <span className="font-medium text-gray-700">{bcartSettings.mapping === 'code' ? '品番検索' : 'BカートID'}</span></span>
                <span>閾値: <span className="font-medium text-gray-700">{bcartSettings.threshold}個以下</span></span>
              </div>
            </div>

            {/* 同期ボタン */}
            {!results && (
              <div className="mb-4">
                <p className="mb-3 text-sm text-gray-600">
                  在庫管理に登録されている <span className="font-bold text-indigo-600">{products.length}件</span> の商品をBカートに同期します。
                </p>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="w-full rounded-lg bg-blue-600 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {syncing ? progress || '同期中...' : '在庫を同期する'}
                </button>
              </div>
            )}

            {/* 同期結果 */}
            {results && (
              <div>
                {/* サマリー */}
                <div className="mb-4 grid grid-cols-4 gap-3">
                  <div className="rounded-lg bg-green-50 p-3 text-center">
                    <div className="text-xs text-green-600">成功</div>
                    <div className="text-2xl font-bold text-green-700">{results.success}</div>
                  </div>
                  <div className="rounded-lg bg-red-50 p-3 text-center">
                    <div className="text-xs text-red-600">失敗</div>
                    <div className="text-2xl font-bold text-red-700">{results.failed}</div>
                  </div>
                  <div className="rounded-lg bg-yellow-50 p-3 text-center">
                    <div className="text-xs text-yellow-600">残りわずか</div>
                    <div className="text-2xl font-bold text-yellow-700">{results.low_stock}</div>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <div className="text-xs text-gray-500">スキップ</div>
                    <div className="text-2xl font-bold text-gray-600">{results.skipped}</div>
                  </div>
                </div>

                {/* 詳細一覧 */}
                <div className="max-h-60 overflow-y-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-gray-500">
                        <th className="px-3 py-2">品番</th>
                        <th className="px-3 py-2">商品名</th>
                        <th className="px-3 py-2">状態</th>
                        <th className="px-3 py-2">備考</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(results.results || []).map((r, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="px-3 py-1.5 font-mono text-gray-600">{r.code}</td>
                          <td className="px-3 py-1.5 text-gray-900 truncate max-w-[200px]">{r.name}</td>
                          <td className="px-3 py-1.5">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              r.status === 'success' ? 'bg-green-100 text-green-700'
                              : r.status === 'failed' ? 'bg-red-100 text-red-700'
                              : 'bg-gray-100 text-gray-600'
                            }`}>
                              {r.status === 'success' ? '成功' : r.status === 'failed' ? '失敗' : 'スキップ'}
                            </span>
                            {r.is_low && (
                              <span className="ml-1 rounded bg-yellow-100 px-1 py-0.5 text-[10px] text-yellow-700">少</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-gray-400 truncate max-w-[150px]">{r.error || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 再同期ボタン */}
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => setResults(null)}
                    className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    再同期する
                  </button>
                  <button
                    onClick={onClose}
                    className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ========================================
// マスタ設定モーダル
// ========================================
function MasterSettingsModal({ brands, categories, warehouses, onSave, onClose }) {
  const [tab, setTab] = useState('brands')
  const [localBrands, setLocalBrands] = useState([...brands])
  const [localCats, setLocalCats] = useState([...categories])
  const [localWhs, setLocalWhs] = useState([...warehouses])
  const [newItem, setNewItem] = useState('')
  const [editIdx, setEditIdx] = useState(-1)
  const [editVal, setEditVal] = useState('')
  const [saving, setSaving] = useState(false)

  const currentList = tab === 'brands' ? localBrands : tab === 'categories' ? localCats : localWhs
  const setCurrentList = tab === 'brands' ? setLocalBrands : tab === 'categories' ? setLocalCats : setLocalWhs
  const label = tab === 'brands' ? 'ブランド' : tab === 'categories' ? '分類' : '保管倉庫'

  const handleAddItem = () => {
    const v = newItem.trim()
    if (!v) return
    if (currentList.includes(v)) { alert('既に存在します'); return }
    setCurrentList([...currentList, v])
    setNewItem('')
  }

  const handleDeleteItem = (idx) => {
    if (!confirm(`「${currentList[idx]}」を削除しますか？`)) return
    setCurrentList(currentList.filter((_, i) => i !== idx))
  }

  const handleStartEdit = (idx) => {
    setEditIdx(idx); setEditVal(currentList[idx])
  }

  const handleSaveEdit = () => {
    const v = editVal.trim()
    if (!v) return
    if (currentList.includes(v) && currentList[editIdx] !== v) { alert('既に存在します'); return }
    setCurrentList(currentList.map((item, i) => i === editIdx ? v : item))
    setEditIdx(-1); setEditVal('')
  }

  const handleMoveUp = (idx) => {
    if (idx === 0) return
    const arr = [...currentList];
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
    setCurrentList(arr)
  }

  const handleMoveDown = (idx) => {
    if (idx === currentList.length - 1) return
    const arr = [...currentList];
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
    setCurrentList(arr)
  }

  const handleSaveAll = async () => {
    setSaving(true)
    try {
      await onSave({ brands: localBrands, categories: localCats, warehouses: localWhs })
      onClose()
    } catch (e) { alert('保存失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  const tabs = [
    { key: 'brands', label: 'ブランド', count: localBrands.length },
    { key: 'categories', label: '分類', count: localCats.length },
    { key: 'warehouses', label: '保管倉庫', count: localWhs.length },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-bold text-gray-900">マスタ設定</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        {/* タブ */}
        <div className="flex border-b border-gray-100 px-6">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); setEditIdx(-1); setNewItem('') }}
              className={`mr-1 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                tab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label} <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{t.count}</span>
            </button>
          ))}
        </div>

        <div className="px-6 py-4">
          {/* 一覧 */}
          <div className="mb-4 max-h-64 overflow-auto rounded-lg border border-gray-200">
            {currentList.length === 0 ? (
              <div className="py-6 text-center text-sm text-gray-400">{label}がありません</div>
            ) : (
              currentList.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between border-b border-gray-50 px-4 py-2 last:border-b-0">
                  {editIdx === idx ? (
                    <div className="flex flex-1 items-center gap-2">
                      <input type="text" value={editVal} onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
                        className="flex-1 rounded border border-indigo-300 px-2 py-1 text-sm focus:outline-none" autoFocus />
                      <button onClick={handleSaveEdit} className="rounded bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-700">OK</button>
                      <button onClick={() => setEditIdx(-1)} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                          tab === 'warehouses' ? badgeColor(item, currentList, WH_PALETTE) : badgeColor(item, currentList, BADGE_PALETTE)}`}>
                          {item}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleMoveUp(idx)} disabled={idx === 0}
                          className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30">▲</button>
                        <button onClick={() => handleMoveDown(idx)} disabled={idx === currentList.length - 1}
                          className="rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30">▼</button>
                        <button onClick={() => handleStartEdit(idx)}
                          className="rounded px-1.5 py-0.5 text-xs text-indigo-500 hover:bg-indigo-50">編集</button>
                        <button onClick={() => handleDeleteItem(idx)}
                          className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50">削除</button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* 新規追加 */}
          <div className="flex gap-2">
            <input type="text" placeholder={`新しい${label}名を入力...`} value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <button onClick={handleAddItem}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">追加</button>
          </div>
        </div>

        {/* フッター */}
        <div className="flex justify-end gap-3 border-t border-gray-100 px-6 py-4">
          <button onClick={onClose}
            className="rounded-lg border border-gray-300 px-5 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button onClick={handleSaveAll} disabled={saving}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
            {saving ? '保存中...' : '全て保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ========================================
// メインコンポーネント
// ========================================
const emptyAdd = { no: '', makerName: '', productName: '', volume: '', stock: '', alertThreshold: ALERT_THRESHOLD_DEFAULT, brand: '', category: '', warehouse: '' }

export default function Inventory() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [brandFilter, setBrandFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [whFilter, setWhFilter] = useState('')
  const [sortKey, setSortKey] = useState('no')
  const [sortAsc, setSortAsc] = useState(true)
  const [selected, setSelected] = useState(null)
  const [history, setHistory] = useState([])
  const [histLoading, setHistLoading] = useState(false)

  // マスタ（Firestoreから読み込む）
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [showMasterSettings, setShowMasterSettings] = useState(false)
  const [showBcartSync, setShowBcartSync] = useState(false)

  // 入出庫
  const [ioType, setIoType] = useState('in')
  const [ioQty, setIoQty] = useState('')
  const [ioNote, setIoNote] = useState('')
  const [saving, setSaving] = useState(false)

  // 倉庫移動
  const [transferTo, setTransferTo] = useState('')
  const [transferQty, setTransferQty] = useState('')
  const [transferNote, setTransferNote] = useState('')

  // 編集
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [editSaving, setEditSaving] = useState(false)

  // 新規追加
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ ...emptyAdd })

  // CSV
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')

  // 在庫推移（個別選択用）
  const [stockYesterday, setStockYesterday] = useState(null)
  const [stockLastMonth, setStockLastMonth] = useState(null)
  // 在庫推移（一覧用: { [productId]: { yesterday, lastMonth } }）
  const [stockSnapshotMap, setStockSnapshotMap] = useState({})

  // タブ
  const [rightTab, setRightTab] = useState('io')

  useEffect(() => { loadMasters(); loadProducts() }, [])

  // マスタ読み込み
  const loadMasters = async () => {
    try {
      const snap = await getDoc(doc(db, 'inventoryMasters', 'config'))
      if (snap.exists()) {
        const d = snap.data()
        setBrands(d.brands || DEFAULT_BRANDS)
        setCategories(d.categories || DEFAULT_CATEGORIES)
        setWarehouses(d.warehouses || DEFAULT_WAREHOUSES)
      } else {
        setBrands(DEFAULT_BRANDS)
        setCategories(DEFAULT_CATEGORIES)
        setWarehouses(DEFAULT_WAREHOUSES)
      }
    } catch (e) {
      console.error('マスタ読み込みエラー:', e)
      setBrands(DEFAULT_BRANDS); setCategories(DEFAULT_CATEGORIES); setWarehouses(DEFAULT_WAREHOUSES)
    }
  }

  // マスタ保存
  const saveMasters = async ({ brands: b, categories: c, warehouses: w }) => {
    await setDoc(doc(db, 'inventoryMasters', 'config'), {
      brands: b, categories: c, warehouses: w, updatedAt: serverTimestamp(),
    })
    setBrands(b); setCategories(c); setWarehouses(w)
  }

  const loadProducts = async () => {
    try {
      const snap = await getDocs(query(collection(db, 'products'), orderBy('no', 'asc')))
      const prods = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setProducts(prods)
      calcAllSnapshots(prods)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  // 全商品の前日在庫・先月末在庫を一括計算
  const calcAllSnapshots = async (prods) => {
    try {
      const now = new Date()
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

      const snap = await getDocs(
        query(collection(db, 'stockHistory'), where('createdAt', '>=', Timestamp.fromDate(monthStart)), orderBy('createdAt', 'asc'))
      )
      // productId毎に変動を集計
      const todayNetMap = {}
      const monthNetMap = {}
      for (const d of snap.docs) {
        const h = d.data()
        const pid = h.productId
        const change = (h.stockAfter ?? 0) - (h.stockBefore ?? 0)
        monthNetMap[pid] = (monthNetMap[pid] || 0) + change
        const ts = h.createdAt?.toDate ? h.createdAt.toDate() : new Date(h.createdAt)
        if (ts >= todayStart) {
          todayNetMap[pid] = (todayNetMap[pid] || 0) + change
        }
      }
      const map = {}
      for (const p of prods) {
        const stock = p.stock || 0
        map[p.id] = {
          yesterday: stock - (todayNetMap[p.id] || 0),
          lastMonth: stock - (monthNetMap[p.id] || 0),
        }
      }
      setStockSnapshotMap(map)
    } catch (e) { console.error('在庫推移一括計算エラー:', e) }
  }

  // CSV取込
  const handleImportCSV = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true); setImportMsg('')
    try {
      const text = await file.text()
      const lines = text.split('\n').filter((l) => l.trim())
      let imported = 0
      const batch = writeBatch(db)
      for (const line of lines) {
        const cols = line.match(/(".*?"|[^,]*),?/g)?.map((c) =>
          c.replace(/,$/, '').replace(/^"|"$/g, '').trim())
        if (!cols || cols.length < 5) continue
        const no = parseInt(cols[0])
        if (isNaN(no) || no <= 0) continue
        const makerName = cols[1] || ''
        const productName = cols[2] || ''
        const volume = cols[3] || ''
        const stock = parseInt(cols[4]) || 0
        if (!productName || productName === '0') continue
        const docId = `SKU-${String(no).padStart(4, '0')}`
        batch.set(doc(db, 'products', docId), {
          no, makerName: makerName === '0' ? '' : makerName, productName,
          volume: volume === '0' ? '' : volume, stock,
          alertThreshold: ALERT_THRESHOLD_DEFAULT, updatedAt: serverTimestamp(),
        }, { merge: true })
        imported++
      }
      await batch.commit()
      setImportMsg(`${imported}件 取り込み完了`)
      await loadProducts()
    } catch (e) { setImportMsg('取込失敗: ' + e.message) }
    finally { setImporting(false); e.target.value = '' }
  }

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
        warehouse: selected.warehouse || '', note: ioNote.trim(), createdAt: serverTimestamp(),
      })
      setProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, stock: newStock } : p)))
      setSelected((prev) => prev ? { ...prev, stock: newStock } : null)
      setIoQty(''); setIoNote('')
      loadHistory(selected.id)
    } catch (e) { alert('処理失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 倉庫移動
  const handleTransfer = async () => {
    if (!selected || !transferTo || !transferQty) return
    if (transferTo === (selected.warehouse || '')) { alert('同じ倉庫です'); return }
    const qty = parseInt(transferQty)
    if (isNaN(qty) || qty <= 0) { alert('数量を正しく入力してください'); return }
    if (qty > (selected.stock || 0)) { alert('在庫数を超えています'); return }
    setSaving(true)
    try {
      const fromWh = selected.warehouse || '未設定'
      if (qty === (selected.stock || 0)) {
        await setDoc(doc(db, 'products', selected.id), { warehouse: transferTo, updatedAt: serverTimestamp() }, { merge: true })
        setProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, warehouse: transferTo } : p)))
        setSelected((prev) => prev ? { ...prev, warehouse: transferTo } : null)
      }
      await addDoc(collection(db, 'stockHistory'), {
        productId: selected.id, productName: selected.productName,
        type: 'transfer', quantity: qty,
        stockBefore: selected.stock || 0, stockAfter: selected.stock || 0,
        warehouseFrom: fromWh, warehouseTo: transferTo, warehouse: transferTo,
        note: transferNote.trim() || `${fromWh} → ${transferTo}`, createdAt: serverTimestamp(),
      })
      setTransferTo(''); setTransferQty(''); setTransferNote('')
      loadHistory(selected.id)
    } catch (e) { alert('移動失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 履歴
  const loadHistory = async (productId) => {
    setHistLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'stockHistory'), orderBy('createdAt', 'desc')))
      setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((h) => h.productId === productId).slice(0, 50))
    } catch (e) { console.error(e) }
    finally { setHistLoading(false) }
  }

  // 入出庫の取消
  const handleCancelIO = async (h) => {
    if (!confirm(`この${h.type === 'in' ? '入庫' : '出庫'}（${h.quantity}個）を取り消しますか？`)) return
    setSaving(true)
    try {
      const prodRef = doc(db, 'products', h.productId)
      const prodSnap = await getDoc(prodRef)
      if (!prodSnap.exists()) { alert('商品が見つかりません'); return }
      const currentStock = prodSnap.data().stock || 0
      const reverseChange = h.type === 'in' ? -h.quantity : h.quantity
      const newStock = currentStock + reverseChange
      if (newStock < 0) { alert('取消すると在庫がマイナスになるため実行できません'); return }
      await setDoc(prodRef, { stock: newStock, updatedAt: serverTimestamp() }, { merge: true })
      await addDoc(collection(db, 'stockHistory'), {
        productId: h.productId, productName: h.productName,
        type: 'cancel', originalType: h.type, quantity: h.quantity,
        stockBefore: currentStock, stockAfter: newStock,
        cancelledHistoryId: h.id,
        warehouse: h.warehouse || '',
        note: `取消: ${h.type === 'in' ? '入庫' : '出庫'} ${h.quantity}個${h.note ? ' / ' + h.note : ''}`,
        createdAt: serverTimestamp(),
      })
      await setDoc(doc(db, 'stockHistory', h.id), { cancelled: true }, { merge: true })
      setProducts((prev) => prev.map((p) => (p.id === h.productId ? { ...p, stock: newStock } : p)))
      if (selected?.id === h.productId) {
        setSelected((prev) => prev ? { ...prev, stock: newStock } : null)
        loadHistory(h.productId)
      }
    } catch (e) { alert('取消失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 在庫推移を計算
  const calcStockSnapshots = async (productId, currentStock) => {
    setStockYesterday(null)
    setStockLastMonth(null)
    try {
      const now = new Date()
      // 今日の0:00
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      // 今月1日の0:00
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

      const snap = await getDocs(
        query(collection(db, 'stockHistory'), where('productId', '==', productId), where('createdAt', '>=', Timestamp.fromDate(monthStart)), orderBy('createdAt', 'asc'))
      )
      const allHistory = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

      // 今日の変動合計
      let todayNet = 0
      let monthNet = 0
      for (const h of allHistory) {
        const change = (h.stockAfter ?? 0) - (h.stockBefore ?? 0)
        monthNet += change
        const ts = h.createdAt?.toDate ? h.createdAt.toDate() : new Date(h.createdAt)
        if (ts >= todayStart) todayNet += change
      }

      setStockYesterday(currentStock - todayNet)
      setStockLastMonth(currentStock - monthNet)
    } catch (e) { console.error('在庫推移計算エラー:', e) }
  }

  const selectProduct = (p) => {
    setSelected(p); setEditing(false); setRightTab('io')
    loadHistory(p.id)
    calcStockSnapshots(p.id, p.stock || 0)
  }

  // 編集
  const startEdit = () => {
    setEditForm({
      productName: selected.productName || '', makerName: selected.makerName || '',
      volume: selected.volume || '', stock: selected.stock ?? 0,
      alertThreshold: selected.alertThreshold ?? ALERT_THRESHOLD_DEFAULT,
      brand: selected.brand || '', category: selected.category || '', warehouse: selected.warehouse || '',
    })
    setEditing(true)
  }
  const saveEdit = async () => {
    if (!selected || !editForm.productName.trim()) { alert('商品名は必須です'); return }
    setEditSaving(true)
    try {
      const data = {
        productName: editForm.productName.trim(), makerName: editForm.makerName.trim(),
        volume: editForm.volume.trim(), stock: parseInt(editForm.stock) || 0,
        alertThreshold: parseInt(editForm.alertThreshold) || ALERT_THRESHOLD_DEFAULT,
        brand: editForm.brand, category: editForm.category, warehouse: editForm.warehouse,
        updatedAt: serverTimestamp(),
      }
      await setDoc(doc(db, 'products', selected.id), data, { merge: true })
      const updated = { ...selected, ...data }
      setProducts((prev) => prev.map((p) => (p.id === selected.id ? updated : p)))
      setSelected(updated); setEditing(false)
    } catch (e) { alert('保存失敗: ' + e.message) }
    finally { setEditSaving(false) }
  }

  // 削除
  const handleDelete = async () => {
    if (!selected) return
    if (!confirm(`「${selected.productName}」を削除しますか？`)) return
    try {
      await deleteDoc(doc(db, 'products', selected.id))
      setProducts((prev) => prev.filter((p) => p.id !== selected.id))
      setSelected(null); setEditing(false)
    } catch (e) { alert('削除失敗: ' + e.message) }
  }

  // 新規追加
  const handleAdd = async () => {
    if (!addForm.productName.trim()) { alert('商品名は必須です'); return }
    const no = parseInt(addForm.no)
    if (isNaN(no) || no <= 0) { alert('NOを正しく入力してください'); return }
    const docId = `SKU-${String(no).padStart(4, '0')}`
    if (products.some((p) => p.id === docId)) { alert(`NO ${no} は既に存在します`); return }
    setEditSaving(true)
    try {
      const data = {
        no, productName: addForm.productName.trim(), makerName: addForm.makerName.trim(),
        volume: addForm.volume.trim(), stock: parseInt(addForm.stock) || 0,
        alertThreshold: parseInt(addForm.alertThreshold) || ALERT_THRESHOLD_DEFAULT,
        brand: addForm.brand, category: addForm.category, warehouse: addForm.warehouse,
        updatedAt: serverTimestamp(),
      }
      await setDoc(doc(db, 'products', docId), data)
      setProducts((prev) => [...prev, { id: docId, ...data }])
      setAdding(false); setAddForm({ ...emptyAdd })
    } catch (e) { alert('追加失敗: ' + e.message) }
    finally { setEditSaving(false) }
  }

  // フィルタ＆ソート
  const filtered = products
    .filter((p) => {
      if (filter === 'low') return p.stock > 0 && p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT)
      if (filter === 'zero') return p.stock === 0
      return true
    })
    .filter((p) => !brandFilter || p.brand === brandFilter)
    .filter((p) => !catFilter || p.category === catFilter)
    .filter((p) => !whFilter || p.warehouse === whFilter)
    .filter((p) => {
      if (!search) return true
      const s = search.toLowerCase()
      return p.productName?.toLowerCase().includes(s) || p.makerName?.toLowerCase().includes(s) || p.volume?.toLowerCase().includes(s)
    })
    .sort((a, b) => {
      let cmp = 0
      if (sortKey === 'no') cmp = (a.no || 0) - (b.no || 0)
      else if (sortKey === 'name') cmp = (a.productName || '').localeCompare(b.productName || '', 'ja')
      else if (sortKey === 'stock') cmp = (a.stock || 0) - (b.stock || 0)
      else if (sortKey === 'brand') cmp = (a.brand || '').localeCompare(b.brand || '', 'ja')
      else if (sortKey === 'warehouse') cmp = (a.warehouse || '').localeCompare(b.warehouse || '', 'ja')
      return sortAsc ? cmp : -cmp
    })

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'no') }
  }
  const sortIcon = (key) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  const totalProducts = products.length
  const totalStock = products.reduce((sum, p) => sum + (p.stock || 0), 0)
  const zeroStock = products.filter((p) => p.stock === 0).length
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT)).length

  // 総在庫の前日比・月初比
  const totalYesterday = Object.keys(stockSnapshotMap).length > 0
    ? products.reduce((sum, p) => sum + (stockSnapshotMap[p.id]?.yesterday ?? (p.stock || 0)), 0) : null
  const totalLastMonth = Object.keys(stockSnapshotMap).length > 0
    ? products.reduce((sum, p) => sum + (stockSnapshotMap[p.id]?.lastMonth ?? (p.stock || 0)), 0) : null
  const diffDay = totalYesterday != null ? totalStock - totalYesterday : null
  const diffMonth = totalLastMonth != null ? totalStock - totalLastMonth : null
  const hasActiveFilter = brandFilter || catFilter || whFilter || filter !== 'all'

  const fmtTime = (ts) => {
    if (!ts) return '—'
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  const renderFormFields = (form, setForm, showNo = false) => (
    <>
      {showNo && <TextField label="NO（番号）" type="number" min={1} value={form.no} onChange={(e) => setForm({ ...form, no: e.target.value })} />}
      <TextField label="商品名 *" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
      <div className="mb-2">
        <SelectField label="ブランド" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} options={brands} placeholder="-- 選択 --" />
      </div>
      <div className="mb-2">
        <SelectField label="分類" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} options={categories} placeholder="-- 選択 --" />
      </div>
      <div className="mb-2">
        <SelectField label="保管倉庫" value={form.warehouse} onChange={(e) => setForm({ ...form, warehouse: e.target.value })} options={warehouses} placeholder="-- 選択 --" />
      </div>
      <TextField label="容量" value={form.volume} onChange={(e) => setForm({ ...form, volume: e.target.value })} />
      <TextField label="在庫数" type="number" min={0} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
      <TextField label="アラート閾値" type="number" min={0} value={form.alertThreshold} onChange={(e) => setForm({ ...form, alertThreshold: e.target.value })} />
    </>
  )

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">在庫管理</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowBcartSync(true)}
            className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100">
            🔄 Bカート在庫同期
          </button>
          <button onClick={() => setShowMasterSettings(true)}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            マスタ設定
          </button>
        </div>
      </div>

      {/* マスタ設定モーダル */}
      {showMasterSettings && (
        <MasterSettingsModal
          brands={brands} categories={categories} warehouses={warehouses}
          onSave={saveMasters} onClose={() => setShowMasterSettings(false)} />
      )}

      {/* Bカート在庫同期モーダル */}
      <BcartSyncModal
        isOpen={showBcartSync}
        onClose={() => setShowBcartSync(false)}
        products={products}
      />

      {/* サマリー */}
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
          <div className="text-xs text-gray-500">全商品</div>
          <div className="text-xl font-bold text-gray-900">{totalProducts}</div>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-center">
          <div className="text-xs text-indigo-500">総在庫数</div>
          <div className="text-xl font-bold text-indigo-700">{fmtNum(totalStock)}</div>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-3 text-center">
          <div className="text-xs text-blue-500">前日比</div>
          {diffDay != null ? (
            <div className={`text-xl font-bold ${diffDay > 0 ? 'text-green-600' : diffDay < 0 ? 'text-red-500' : 'text-gray-400'}`}>
              {diffDay > 0 ? '+' : ''}{fmtNum(diffDay)}
            </div>
          ) : <div className="text-xl font-bold text-gray-300">—</div>}
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 px-5 py-3 text-center">
          <div className="text-xs text-purple-500">月初比</div>
          {diffMonth != null ? (
            <div className={`text-xl font-bold ${diffMonth > 0 ? 'text-green-600' : diffMonth < 0 ? 'text-red-500' : 'text-gray-400'}`}>
              {diffMonth > 0 ? '+' : ''}{fmtNum(diffMonth)}
            </div>
          ) : <div className="text-xl font-bold text-gray-300">—</div>}
        </div>
        <div className={`cursor-pointer rounded-xl border px-5 py-3 text-center ${filter === 'zero' ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white'}`}
          onClick={() => setFilter(filter === 'zero' ? 'all' : 'zero')}>
          <div className="text-xs text-red-500">在庫切れ</div>
          <div className="text-xl font-bold text-red-600">{zeroStock}</div>
        </div>
        <div className={`cursor-pointer rounded-xl border px-5 py-3 text-center ${filter === 'low' ? 'border-yellow-400 bg-yellow-50' : 'border-gray-200 bg-white'}`}
          onClick={() => setFilter(filter === 'low' ? 'all' : 'low')}>
          <div className="text-xs text-yellow-600">残りわずか</div>
          <div className="text-xl font-bold text-yellow-600">{lowStock}</div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-indigo-300 bg-indigo-50 px-5 py-3 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
          CSV取込
          <input type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} className="hidden" />
        </label>
        <button onClick={() => { setAdding(true); setSelected(null); setEditing(false) }}
          className="rounded-xl border border-green-300 bg-green-50 px-5 py-3 text-sm font-medium text-green-700 hover:bg-green-100">
          ＋ 新規追加
        </button>
        {importMsg && <div className="flex items-center rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">{importMsg}</div>}
      </div>

      {/* 検索 + フィルタ */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="text" placeholder="商品名・メーカー名で検索..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
          <option value="">全ブランド</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
          <option value="">全分類</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={whFilter} onChange={(e) => setWhFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none">
          <option value="">全倉庫</option>
          {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        {hasActiveFilter && (
          <button onClick={() => { setFilter('all'); setBrandFilter(''); setCatFilter(''); setWhFilter('') }}
            className="text-sm text-indigo-600 hover:underline">フィルタ解除</button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：商品一覧 */}
        <div className="lg:col-span-2">
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('no')}>NO{sortIcon('no')}</th>
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('name')}>商品名{sortIcon('name')}</th>
                  <th className="px-2 py-2">容量</th>
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('brand')}>ブランド{sortIcon('brand')}</th>
                  <th className="px-2 py-2">分類</th>
                  <th className="cursor-pointer px-2 py-2 hover:text-gray-900" onClick={() => handleSort('warehouse')}>倉庫{sortIcon('warehouse')}</th>
                  <th className="cursor-pointer px-2 py-2 text-right hover:text-gray-900" onClick={() => handleSort('stock')}>在庫{sortIcon('stock')}</th>
                  <th className="px-2 py-2 text-right">前日比</th>
                  <th className="px-2 py-2 text-right">月初比</th>
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
                      <td className="px-2 py-2">
                        <div className="font-medium text-gray-900">{p.productName}</div>
                        {p.makerName && <div className="text-xs text-gray-400">{p.makerName}</div>}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500">{p.volume || ''}</td>
                      <td className="px-2 py-2">
                        {p.brand && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor(p.brand, brands, BADGE_PALETTE)}`}>
                            {p.brand}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500">{p.category || ''}</td>
                      <td className="px-2 py-2">
                        {p.warehouse && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor(p.warehouse, warehouses, WH_PALETTE)}`}>
                            {p.warehouse}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span className={`font-bold ${isZero ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-gray-900'}`}>
                          {fmtNum(p.stock)}
                        </span>
                        {isZero && <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-600">切れ</span>}
                        {isLow && <span className="ml-1 rounded bg-yellow-100 px-1 py-0.5 text-[10px] text-yellow-700">少</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        {stockSnapshotMap[p.id] != null ? (() => {
                          const diff = (p.stock || 0) - stockSnapshotMap[p.id].yesterday
                          if (diff === 0) return <span className="text-gray-400">±0</span>
                          return <span className={`font-medium ${diff > 0 ? 'text-green-600' : 'text-red-500'}`}>{diff > 0 ? '+' : ''}{fmtNum(diff)}</span>
                        })() : '—'}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        {stockSnapshotMap[p.id] != null ? (() => {
                          const diff = (p.stock || 0) - stockSnapshotMap[p.id].lastMonth
                          if (diff === 0) return <span className="text-gray-400">±0</span>
                          return <span className={`font-medium ${diff > 0 ? 'text-green-600' : 'text-red-500'}`}>{diff > 0 ? '+' : ''}{fmtNum(diff)}</span>
                        })() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-gray-400">
                {products.length === 0 ? 'CSVファイルを取り込んでください' : '該当する商品がありません'}
              </div>
            )}
          </div>
          <div className="mt-2 text-xs text-gray-400">{filtered.length} / {totalProducts} 件表示</div>
        </div>

        {/* 右パネル */}
        <div className="lg:col-span-1">
          {adding ? (
            <div className="rounded-xl border border-green-200 bg-white p-4">
              <h3 className="mb-3 text-sm font-bold text-green-700">商品を新規追加</h3>
              {renderFormFields(addForm, setAddForm, true)}
              <div className="mt-3 flex gap-2">
                <button onClick={handleAdd} disabled={editSaving}
                  className="flex-1 rounded-lg bg-green-600 py-2 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-40">
                  {editSaving ? '保存中...' : '追加する'}
                </button>
                <button onClick={() => setAdding(false)}
                  className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
              </div>
            </div>

          ) : selected ? (
            <div>
              <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                {editing ? (
                  <>
                    {renderFormFields(editForm, setEditForm)}
                    <div className="mt-3 flex gap-2">
                      <button onClick={saveEdit} disabled={editSaving}
                        className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                        {editSaving ? '保存中...' : '保存'}
                      </button>
                      <button onClick={() => setEditing(false)}
                        className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-lg font-bold text-gray-900">{selected.productName}</div>
                    {selected.makerName && <div className="text-xs text-gray-500">{selected.makerName}</div>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selected.brand && (
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor(selected.brand, brands, BADGE_PALETTE)}`}>
                          {selected.brand}
                        </span>
                      )}
                      {selected.category && (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{selected.category}</span>
                      )}
                      {selected.warehouse && (
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor(selected.warehouse, warehouses, WH_PALETTE)}`}>
                          {selected.warehouse}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="text-3xl font-bold text-indigo-600">{fmtNum(selected.stock)}</span>
                      <span className="text-sm text-gray-500">{selected.volume}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-center">
                        <div className="text-[10px] text-gray-400">前日在庫</div>
                        <div className="text-lg font-bold text-gray-700">{stockYesterday != null ? fmtNum(stockYesterday) : '—'}</div>
                        {stockYesterday != null && selected.stock !== stockYesterday && (
                          <div className={`text-[10px] font-medium ${selected.stock - stockYesterday > 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {selected.stock - stockYesterday > 0 ? '+' : ''}{fmtNum(selected.stock - stockYesterday)}
                          </div>
                        )}
                      </div>
                      <div className="rounded-lg bg-gray-50 px-3 py-2 text-center">
                        <div className="text-[10px] text-gray-400">先月末在庫</div>
                        <div className="text-lg font-bold text-gray-700">{stockLastMonth != null ? fmtNum(stockLastMonth) : '—'}</div>
                        {stockLastMonth != null && selected.stock !== stockLastMonth && (
                          <div className={`text-[10px] font-medium ${selected.stock - stockLastMonth > 0 ? 'text-green-600' : 'text-red-500'}`}>
                            {selected.stock - stockLastMonth > 0 ? '+' : ''}{fmtNum(selected.stock - stockLastMonth)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button onClick={startEdit}
                        className="flex-1 rounded-lg border border-indigo-300 bg-indigo-50 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">編集</button>
                      <button onClick={handleDelete}
                        className="flex-1 rounded-lg border border-red-300 bg-red-50 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100">削除</button>
                    </div>
                  </>
                )}
              </div>

              {!editing && (
                <>
                  <div className="mb-3 flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                    {[{ key: 'io', label: '入出庫' }, { key: 'transfer', label: '倉庫移動' }, { key: 'history', label: '履歴' }].map((t) => (
                      <button key={t.key} onClick={() => setRightTab(t.key)}
                        className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                          rightTab === t.key ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                        {t.label}
                      </button>
                    ))}
                  </div>

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
                      <input type="text" placeholder="備考" value={ioNote} onChange={(e) => setIoNote(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleIO()}
                        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                      <button onClick={handleIO} disabled={saving || !ioQty}
                        className={`w-full rounded-lg py-2 text-sm font-bold text-white ${ioType === 'in' ? 'bg-green-600 hover:bg-green-700' : 'bg-orange-500 hover:bg-orange-600'} disabled:opacity-40`}>
                        {saving ? '処理中...' : ioType === 'in' ? '入庫する' : '出庫する'}
                      </button>
                    </div>
                  )}

                  {rightTab === 'transfer' && (
                    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                      <div className="mb-2 text-xs text-gray-500">
                        現在の倉庫: <span className="font-medium text-gray-900">{selected.warehouse || '未設定'}</span>
                      </div>
                      <div className="mb-2">
                        <SelectField label="移動先" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}
                          options={warehouses.filter((w) => w !== selected.warehouse)} placeholder="-- 移動先を選択 --" />
                      </div>
                      <input type="number" min="1" max={selected.stock || 0} placeholder="移動数量"
                        value={transferQty} onChange={(e) => setTransferQty(e.target.value)}
                        className="mb-2 mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                      <input type="text" placeholder="備考（任意）" value={transferNote} onChange={(e) => setTransferNote(e.target.value)}
                        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
                      <button onClick={handleTransfer} disabled={saving || !transferTo || !transferQty}
                        className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                        {saving ? '処理中...' : '移動する'}
                      </button>
                    </div>
                  )}

                  {rightTab === 'history' && (
                    <div className="rounded-xl border border-gray-200 bg-white" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                      <div className="sticky top-0 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-bold text-gray-600">入出庫・移動履歴</div>
                      {histLoading ? (
                        <div className="py-6 text-center text-xs text-gray-400">読み込み中...</div>
                      ) : history.length === 0 ? (
                        <div className="py-6 text-center text-xs text-gray-400">履歴なし</div>
                      ) : (
                        history.map((h) => (
                          <div key={h.id} className={`flex items-center justify-between border-b border-gray-50 px-4 py-2 ${h.cancelled ? 'opacity-40' : ''}`}>
                            <div>
                              <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                h.type === 'cancel' ? 'bg-red-100 text-red-700'
                                : h.type === 'in' ? 'bg-green-100 text-green-700'
                                : h.type === 'out' ? 'bg-orange-100 text-orange-700'
                                : 'bg-indigo-100 text-indigo-700'}`}>
                                {h.type === 'cancel' ? '取消' : h.type === 'in' ? '入庫' : h.type === 'out' ? '出庫' : '移動'}
                              </span>
                              {h.cancelled && <span className="mr-1 text-[10px] text-red-400 line-through">取消済</span>}
                              {h.type === 'transfer' ? (
                                <span className="text-xs text-gray-700">{h.warehouseFrom} → {h.warehouseTo} ({h.quantity}個)</span>
                              ) : h.type === 'cancel' ? (
                                <span className="text-xs text-red-600">{h.originalType === 'in' ? '入庫' : '出庫'} {h.quantity}個 取消</span>
                              ) : (
                                <>
                                  <span className="text-sm font-medium">{h.type === 'in' ? '+' : '-'}{h.quantity}</span>
                                  <span className="ml-2 text-xs text-gray-400">→ {fmtNum(h.stockAfter)}</span>
                                </>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {(h.type === 'in' || h.type === 'out') && !h.cancelled && (
                                <button onClick={(e) => { e.stopPropagation(); handleCancelIO(h) }} disabled={saving}
                                  className="rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-500 hover:bg-red-100 disabled:opacity-40">
                                  取消
                                </button>
                              )}
                              <div className="text-right">
                                <div className="text-[10px] text-gray-400">{fmtTime(h.createdAt)}</div>
                                {h.note && h.type !== 'transfer' && <div className="text-[10px] text-gray-500">{h.note}</div>}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </>
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
