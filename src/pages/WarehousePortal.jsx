import { useEffect, useRef, useState } from 'react'
import {
  collection, doc, getDocs, getDoc, deleteDoc, orderBy, limit, where,
  query, serverTimestamp, setDoc, writeBatch, addDoc, onSnapshot, Timestamp,
} from 'firebase/firestore'
import { getAuth, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { useAuth } from '../contexts/AuthContext.jsx'
import { db, storage } from '../lib/firebase.js'

const ALERT_THRESHOLD_DEFAULT = 10

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString()
}

const BADGE_PALETTE = [
  'bg-purple-100 text-purple-700', 'bg-blue-100 text-blue-700',
  'bg-pink-100 text-pink-700', 'bg-teal-100 text-teal-700',
]
function badgeColor(name, list) {
  const idx = list.indexOf(name)
  return idx < 0 ? 'bg-gray-100 text-gray-600' : BADGE_PALETTE[idx % BADGE_PALETTE.length]
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
// 倉庫チャットコンポーネント
// ========================================
const CHAT_ROOM = 'warehouse_chat'

function WarehouseChat({ user, profile }) {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [attachFile, setAttachFile] = useState(null)
  const [attachPreview, setAttachPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const q = query(
      collection(db, 'chatRooms', CHAT_ROOM, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(200),
    )
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    })
    if (user?.uid) {
      setDoc(doc(db, 'chatRooms', CHAT_ROOM, 'readers', user.uid), {
        uid: user.uid, lastRead: serverTimestamp(),
      }, { merge: true }).catch(() => {})
    }
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user?.uid || messages.length === 0) return
    setDoc(doc(db, 'chatRooms', CHAT_ROOM, 'readers', user.uid), {
      uid: user.uid, lastRead: serverTimestamp(),
    }, { merge: true }).catch(() => {})
  }, [messages.length])

  const fmtFileSize = (bytes) => {
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  }

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      alert('ファイルサイズは10MB以下にしてください')
      e.target.value = ''
      return
    }
    setAttachFile(file)
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => setAttachPreview(ev.target.result)
      reader.readAsDataURL(file)
    } else {
      setAttachPreview(null)
    }
  }

  const clearAttach = () => {
    setAttachFile(null)
    setAttachPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSend = async () => {
    const msg = text.trim()
    if (!msg && !attachFile) return
    if (sending) return
    setSending(true)
    setUploading(!!attachFile)
    try {
      let fileData = null
      if (attachFile) {
        const ts = Date.now()
        const safeName = attachFile.name.replace(/[^a-zA-Z0-9._\-\u3000-\u9FFF]/g, '_')
        const path = `chat/${CHAT_ROOM}/${ts}_${safeName}`
        const storageRef = ref(storage, path)
        await uploadBytes(storageRef, attachFile)
        const url = await getDownloadURL(storageRef)
        fileData = {
          fileName: attachFile.name,
          fileUrl: url,
          fileType: attachFile.type,
          fileSize: attachFile.size,
        }
      }

      await addDoc(collection(db, 'chatRooms', CHAT_ROOM, 'messages'), {
        text: msg, uid: user.uid,
        name: profile?.name || user.email,
        createdAt: serverTimestamp(),
        ...(fileData || {}),
      })
      const lastMsg = msg || (fileData ? `📎 ${fileData.fileName}` : '')
      await setDoc(doc(db, 'chatRooms', CHAT_ROOM), {
        lastMessage: lastMsg, lastMessageAt: serverTimestamp(),
        lastMessageBy: profile?.name || user.email,
      }, { merge: true })
      setText('')
      clearAttach()
      inputRef.current?.focus()
    } catch (e) { alert('送信失敗: ' + e.message) }
    finally { setSending(false); setUploading(false) }
  }

  const fmtChatTime = (ts) => {
    if (!ts) return ''
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    const now = new Date()
    const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    if (isToday) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
  }

  const isMe = (msg) => msg.uid === user?.uid

  const handleDelete = async (msgId) => {
    if (!window.confirm('このメッセージを取り消しますか？')) return
    try {
      await deleteDoc(doc(db, 'chatRooms', CHAT_ROOM, 'messages', msgId))
    } catch (e) { alert('取り消し失敗: ' + e.message) }
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white" style={{ height: '480px' }}>
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
        <div className="text-sm font-bold text-gray-700">💬 業務連絡チャット</div>
        <div className="text-[10px] text-gray-400">本社スタッフとリアルタイムで連絡できます</div>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="py-8 text-center text-xs text-gray-400">まだメッセージがありません</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`group flex ${isMe(m) ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] ${isMe(m) ? 'order-last' : ''}`}>
              {!isMe(m) && <div className="mb-0.5 text-[10px] font-medium text-gray-500">{m.name}</div>}
              <div className={`rounded-2xl px-3.5 py-2 text-sm ${isMe(m) ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-800'}`}>
                {/* 画像添付 */}
                {m.fileUrl && m.fileType?.startsWith('image/') && (
                  <a href={m.fileUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: m.text ? '6px' : 0 }}>
                    <img src={m.fileUrl} alt={m.fileName} className="rounded-lg" style={{ maxWidth: '200px', maxHeight: '160px', cursor: 'pointer' }} />
                  </a>
                )}
                {/* ファイル添付（画像以外） */}
                {m.fileUrl && !m.fileType?.startsWith('image/') && (
                  <a href={m.fileUrl} target="_blank" rel="noopener noreferrer"
                    className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs no-underline ${isMe(m) ? 'bg-white/15 text-white' : 'bg-gray-200 text-indigo-600'}`}
                    style={{ marginBottom: m.text ? '6px' : 0, textDecoration: 'none' }}>
                    <span>📎</span>
                    <span className="flex-1 truncate">{m.fileName || 'ファイル'}</span>
                    {m.fileSize && <span className="opacity-70">{fmtFileSize(m.fileSize)}</span>}
                  </a>
                )}
                {m.text}
              </div>
              <div className={`mt-0.5 flex items-center gap-2 text-[10px] text-gray-400 ${isMe(m) ? 'justify-end' : ''}`}>
                {fmtChatTime(m.createdAt)}
                {isMe(m) && (
                  <button onClick={() => handleDelete(m.id)}
                    className="hidden rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-100 group-hover:inline-block">
                    取消
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 添付プレビュー */}
      {attachFile && (
        <div className="border-t border-gray-100 px-3 pt-2">
          <div className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-700">
            {attachPreview ? (
              <img src={attachPreview} alt="" className="rounded" style={{ width: '32px', height: '32px', objectFit: 'cover' }} />
            ) : <span>📎</span>}
            <span className="max-w-[140px] truncate">{attachFile.name}</span>
            <span className="text-gray-400">{fmtFileSize(attachFile.size)}</span>
            <button onClick={clearAttach} className="text-gray-400 hover:text-gray-600" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>×</button>
          </div>
        </div>
      )}

      <div className="border-t border-gray-100 p-3">
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" onChange={handleFileSelect} style={{ display: 'none' }}
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" />
          <button onClick={() => fileInputRef.current?.click()} title="ファイルを添付"
            className="flex-shrink-0 rounded-full border border-gray-300 px-2.5 py-2 text-sm text-gray-500 hover:bg-gray-100">
            📎
          </button>
          <input ref={inputRef} type="text" value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder={uploading ? 'アップロード中...' : 'メッセージを入力...'}
            disabled={uploading}
            className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          <button onClick={handleSend} disabled={(sending || (!text.trim() && !attachFile))}
            className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
            {uploading ? '送信中' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ========================================
// メインコンポーネント
// ========================================
export default function WarehousePortal() {
  const { user, profile, logout } = useAuth()
  const myWarehouse = profile?.warehouseName || ''

  // メインタブ
  const [mainTab, setMainTab] = useState('dashboard')
  const [now, setNow] = useState(new Date())

  // パスワード変更
  const [showPwModal, setShowPwModal] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPwConfirm, setNewPwConfirm] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState('')

  const handleChangePassword = async () => {
    setPwMsg(''); setPwError('')
    if (!currentPw) { setPwError('現在のパスワードを入力してください'); return }
    if (newPw.length < 8) { setPwError('新しいパスワードは8文字以上で入力してください'); return }
    if (newPw !== newPwConfirm) { setPwError('新しいパスワードが一致しません'); return }
    setPwSaving(true)
    try {
      const auth = getAuth()
      const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPw)
      await reauthenticateWithCredential(auth.currentUser, credential)
      await updatePassword(auth.currentUser, newPw)
      setPwMsg('パスワードを変更しました')
      setCurrentPw(''); setNewPw(''); setNewPwConfirm('')
    } catch (e) {
      if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') {
        setPwError('現在のパスワードが正しくありません')
      } else {
        setPwError('変更に失敗しました: ' + e.message)
      }
    } finally { setPwSaving(false) }
  }
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(id)
  }, [])

  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [brands, setBrands] = useState([])
  const [categories, setCategories] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [sortKey, setSortKey] = useState('no')
  const [sortAsc, setSortAsc] = useState(true)

  const [selected, setSelected] = useState(null)
  const [history, setHistory] = useState([])
  const [histLoading, setHistLoading] = useState(false)

  const [ioType, setIoType] = useState('in')
  const [ioQty, setIoQty] = useState('')
  const [ioNote, setIoNote] = useState('')
  const [saving, setSaving] = useState(false)

  const [transferTo, setTransferTo] = useState('')
  const [transferQty, setTransferQty] = useState('')
  const [transferNote, setTransferNote] = useState('')

  const [rightTab, setRightTab] = useState('io')

  // 編集
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [editSaving, setEditSaving] = useState(false)

  // CSV取込
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')

  // 在庫推移（前日比・月初比）
  const [stockSnapshotMap, setStockSnapshotMap] = useState({})

  // 倉庫全体ログ
  const [whHistory, setWhHistory] = useState([])
  const [whHistLoading, setWhHistLoading] = useState(false)

  useEffect(() => { if (myWarehouse) loadAll() }, [myWarehouse])

  const loadAll = async () => {
    try {
      const [masterSnap, prodSnap] = await Promise.all([
        getDoc(doc(db, 'inventoryMasters', 'config')),
        getDocs(query(collection(db, 'products'), orderBy('no', 'asc'))),
      ])
      const m = masterSnap.exists() ? masterSnap.data() : {}
      setBrands(m.brands || [])
      setCategories(m.categories || [])
      setWarehouses(m.warehouses || [])
      const prods = prodSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setProducts(prods)
      calcAllSnapshots(prods)
      loadWhHistory()
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  const loadWhHistory = async () => {
    setWhHistLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'stockHistory'), orderBy('createdAt', 'desc')))
      setWhHistory(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .filter((h) => h.warehouse === myWarehouse || h.warehouseFrom === myWarehouse || h.warehouseTo === myWarehouse)
          .slice(0, 100)
      )
    } catch (e) { console.error(e) }
    finally { setWhHistLoading(false) }
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
    } catch (e) { console.error('在庫推移計算エラー:', e) }
  }

  const loadHistory = async (productId) => {
    setHistLoading(true)
    try {
      const snap = await getDocs(query(collection(db, 'stockHistory'), orderBy('createdAt', 'desc')))
      setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((h) => h.productId === productId).slice(0, 50))
    } catch (e) { console.error(e) }
    finally { setHistLoading(false) }
  }

  const whProducts = products.filter((p) => p.warehouse === myWarehouse)

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
      return sortAsc ? cmp : -cmp
    })

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'no') }
  }
  const sortIcon = (key) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''

  const selectProduct = (p) => { setSelected(p); setEditing(false); setRightTab('io'); loadHistory(p.id) }

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
        warehouse: myWarehouse, operatorUid: user?.uid, operatorName: profile?.name || '',
        note: ioNote.trim(), createdAt: serverTimestamp(),
      })
      setProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, stock: newStock } : p)))
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
    if (transferTo === myWarehouse) { alert('同じ倉庫です'); return }
    const qty = parseInt(transferQty)
    if (isNaN(qty) || qty <= 0) { alert('数量を正しく入力してください'); return }
    if (qty > (selected.stock || 0)) { alert('在庫数を超えています'); return }
    setSaving(true)
    try {
      if (qty === (selected.stock || 0)) {
        await setDoc(doc(db, 'products', selected.id), { warehouse: transferTo, updatedAt: serverTimestamp() }, { merge: true })
        setProducts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, warehouse: transferTo } : p)))
        setSelected(null)
      }
      await addDoc(collection(db, 'stockHistory'), {
        productId: selected.id, productName: selected.productName,
        type: 'transfer', quantity: qty,
        stockBefore: selected.stock || 0, stockAfter: selected.stock || 0,
        warehouseFrom: myWarehouse, warehouseTo: transferTo, warehouse: transferTo,
        operatorUid: user?.uid, operatorName: profile?.name || '',
        note: transferNote.trim() || `${myWarehouse} → ${transferTo}`,
        createdAt: serverTimestamp(),
      })
      setTransferTo(''); setTransferQty(''); setTransferNote('')
      if (selected) loadHistory(selected.id)
      loadWhHistory()
    } catch (e) { alert('移動失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 入出庫の取消
  const handleCancelIO = async (h) => {
    if (!confirm(`この${h.type === 'in' ? '入庫' : '出庫'}（${h.quantity}個）を取り消しますか？`)) return
    setSaving(true)
    try {
      // 現在の商品の在庫を取得
      const prodRef = doc(db, 'products', h.productId)
      const prodSnap = await getDoc(prodRef)
      if (!prodSnap.exists()) { alert('商品が見つかりません'); return }
      const currentStock = prodSnap.data().stock || 0
      // 逆算：入庫の取消→在庫を減らす、出庫の取消→在庫を増やす
      const reverseChange = h.type === 'in' ? -h.quantity : h.quantity
      const newStock = currentStock + reverseChange
      if (newStock < 0) { alert('取消すると在庫がマイナスになるため実行できません'); return }
      // 在庫更新
      await setDoc(prodRef, { stock: newStock, updatedAt: serverTimestamp() }, { merge: true })
      // 取消履歴を追加
      await addDoc(collection(db, 'stockHistory'), {
        productId: h.productId, productName: h.productName,
        type: 'cancel', originalType: h.type, quantity: h.quantity,
        stockBefore: currentStock, stockAfter: newStock,
        cancelledHistoryId: h.id,
        warehouse: h.warehouse || myWarehouse,
        operatorUid: user?.uid, operatorName: profile?.name || '',
        note: `取消: ${h.type === 'in' ? '入庫' : '出庫'} ${h.quantity}個${h.note ? ' / ' + h.note : ''}`,
        createdAt: serverTimestamp(),
      })
      // 元の履歴に取消済みフラグ
      await setDoc(doc(db, 'stockHistory', h.id), { cancelled: true }, { merge: true })
      // UI更新
      setProducts((prev) => prev.map((p) => (p.id === h.productId ? { ...p, stock: newStock } : p)))
      if (selected?.id === h.productId) {
        setSelected((prev) => prev ? { ...prev, stock: newStock } : null)
        loadHistory(h.productId)
      }
      loadWhHistory()
    } catch (e) { alert('取消失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  // 編集開始
  const startEdit = () => {
    setEditForm({
      productName: selected.productName || '',
      volume: selected.volume || '',
      stock: selected.stock ?? 0,
      alertThreshold: selected.alertThreshold ?? ALERT_THRESHOLD_DEFAULT,
      brand: selected.brand || '',
      category: selected.category || '',
    })
    setEditing(true)
    setRightTab('edit')
  }

  // 編集保存
  const saveEdit = async () => {
    if (!selected || !editForm.productName.trim()) { alert('商品名は必須です'); return }
    setEditSaving(true)
    try {
      const data = {
        productName: editForm.productName.trim(),
        volume: editForm.volume.trim(),
        stock: parseInt(editForm.stock) || 0,
        alertThreshold: parseInt(editForm.alertThreshold) || ALERT_THRESHOLD_DEFAULT,
        brand: editForm.brand,
        category: editForm.category,
        updatedAt: serverTimestamp(),
      }
      await setDoc(doc(db, 'products', selected.id), data, { merge: true })
      const updated = { ...selected, ...data }
      setProducts((prev) => prev.map((p) => (p.id === selected.id ? updated : p)))
      setSelected(updated)
      setEditing(false)
      setRightTab('io')
    } catch (e) { alert('保存失敗: ' + e.message) }
    finally { setEditSaving(false) }
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
          warehouse: myWarehouse,
          alertThreshold: ALERT_THRESHOLD_DEFAULT, updatedAt: serverTimestamp(),
        }, { merge: true })
        imported++
      }
      await batch.commit()
      setImportMsg(`${imported}件 取り込み完了`)
      await loadAll()
    } catch (e) { setImportMsg('取込失敗: ' + e.message) }
    finally { setImporting(false); e.target.value = '' }
  }

  const totalInWh = whProducts.length
  const totalStock = whProducts.reduce((s, p) => s + (p.stock || 0), 0)
  const zeroStock = whProducts.filter((p) => p.stock === 0).length

  // 総在庫の前日比・月初比
  const hasSnapshots = Object.keys(stockSnapshotMap).length > 0
  const whTotalYesterday = hasSnapshots
    ? whProducts.reduce((s, p) => s + (stockSnapshotMap[p.id]?.yesterday ?? (p.stock || 0)), 0) : null
  const whTotalLastMonth = hasSnapshots
    ? whProducts.reduce((s, p) => s + (stockSnapshotMap[p.id]?.lastMonth ?? (p.stock || 0)), 0) : null
  const whDiffDay = whTotalYesterday != null ? totalStock - whTotalYesterday : null
  const whDiffMonth = whTotalLastMonth != null ? totalStock - whTotalLastMonth : null

  const fmtTime = (ts) => {
    if (!ts) return '—'
    const d = ts.toDate ? ts.toDate() : new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // 編集フォーム（倉庫フィールドなし）
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
      <TextField label="容量" value={form.volume} onChange={(e) => setForm({ ...form, volume: e.target.value })} />
      <TextField label="在庫数" type="number" min={0} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
      <TextField label="アラート閾値" type="number" min={0} value={form.alertThreshold} onChange={(e) => setForm({ ...form, alertThreshold: e.target.value })} />
    </>
  )

  if (!myWarehouse) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-gray-50">
        <div className="text-lg font-bold text-red-600">倉庫が割り当てられていません</div>
        <div className="mt-2 text-sm text-gray-500">管理者にお問い合わせください</div>
        <button onClick={logout} className="mt-6 rounded-lg bg-gray-200 px-6 py-2 text-sm text-gray-700 hover:bg-gray-300">ログアウト</button>
      </div>
    )
  }

  const dayNames = ['日', '月', '火', '水', '木', '金', '土']
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${dayNames[now.getDay()]}）`
  const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ヘッダー */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div>
            <span className="text-lg font-bold text-gray-900">{myWarehouse}</span>
            <span className="ml-2 rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">倉庫管理</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{profile?.name || profile?.email}</span>
            <button onClick={() => { setShowPwModal(true); setPwMsg(''); setPwError('') }}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50">PW変更</button>
            <button onClick={logout}
              className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50">ログアウト</button>
          </div>
        </div>
        {/* メインタブ */}
        <div className="mx-auto flex max-w-7xl gap-0 px-6">
          {[
            { key: 'dashboard', label: 'ダッシュボード' },
            { key: 'inventory', label: '在庫管理' },
          ].map((t) => (
            <button key={t.key} onClick={() => setMainTab(t.key)}
              className={`border-b-2 px-5 py-2.5 text-sm font-medium transition-colors ${
                mainTab === t.key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* パスワード変更モーダル */}
      {showPwModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-bold text-gray-900">パスワード変更</h3>
            <label className="mb-1 block text-xs text-gray-500">現在のパスワード</label>
            <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <label className="mb-1 block text-xs text-gray-500">新しいパスワード（8文字以上）</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <label className="mb-1 block text-xs text-gray-500">新しいパスワード（確認）</label>
            <input type="password" value={newPwConfirm} onChange={(e) => setNewPwConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
              className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            {pwError && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{pwError}</div>}
            {pwMsg && <div className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{pwMsg}</div>}
            <div className="flex gap-2">
              <button onClick={handleChangePassword} disabled={pwSaving}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                {pwSaving ? '変更中...' : '変更する'}
              </button>
              <button onClick={() => { setShowPwModal(false); setCurrentPw(''); setNewPw(''); setNewPwConfirm('') }}
                className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-7xl px-6 py-6">
        {loading ? (
          <div className="py-20 text-center text-gray-400">読み込み中...</div>
        ) : mainTab === 'dashboard' ? (
          /* ===== ダッシュボード ===== */
          <div>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900">ダッシュボード</h2>
                <p className="text-sm text-gray-500">こんにちは、{profile?.name || profile?.email} さん</p>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium text-gray-600">{dateStr}</div>
                <div className="text-4xl font-bold tabular-nums text-gray-900">{timeStr}</div>
              </div>
            </div>

            {/* 在庫サマリーカード */}
            <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
                <div className="text-xs text-indigo-500">総在庫数</div>
                <div className="mt-2 text-3xl font-bold text-indigo-700">{fmtNum(totalStock)}</div>
                <div className="mt-1 text-xs text-indigo-400">{totalInWh}商品</div>
              </div>
              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
                <div className="text-xs text-blue-500">前日比</div>
                {whDiffDay != null ? (
                  <div className={`mt-2 text-3xl font-bold ${whDiffDay > 0 ? 'text-green-600' : whDiffDay < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {whDiffDay > 0 ? '+' : ''}{fmtNum(whDiffDay)}
                  </div>
                ) : <div className="mt-2 text-3xl font-bold text-gray-300">—</div>}
              </div>
              <div className="rounded-2xl border border-purple-200 bg-purple-50 p-5">
                <div className="text-xs text-purple-500">月初比</div>
                {whDiffMonth != null ? (
                  <div className={`mt-2 text-3xl font-bold ${whDiffMonth > 0 ? 'text-green-600' : whDiffMonth < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {whDiffMonth > 0 ? '+' : ''}{fmtNum(whDiffMonth)}
                  </div>
                ) : <div className="mt-2 text-3xl font-bold text-gray-300">—</div>}
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="text-xs text-gray-500">管理商品数</div>
                <div className="mt-2 text-3xl font-bold text-gray-900">{totalInWh}</div>
              </div>
              <div className="rounded-2xl border border-red-200 bg-red-50 p-5 cursor-pointer" onClick={() => setMainTab('inventory')}>
                <div className="text-xs text-red-500">在庫切れ</div>
                <div className="mt-2 text-3xl font-bold text-red-600">{zeroStock}</div>
                {zeroStock > 0 && <div className="mt-1 text-xs text-red-400">要確認 →</div>}
              </div>
              <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-5 cursor-pointer" onClick={() => setMainTab('inventory')}>
                <div className="text-xs text-yellow-600">残りわずか</div>
                <div className="mt-2 text-3xl font-bold text-yellow-600">
                  {whProducts.filter((p) => p.stock > 0 && p.stock <= (p.alertThreshold || ALERT_THRESHOLD_DEFAULT)).length}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* 左カラム：Bカートリンク */}
              <div className="space-y-6">
                <div className="rounded-2xl border border-gray-200 bg-white p-6">
                  <h3 className="mb-3 text-sm font-bold text-gray-700">外部サービス</h3>
                  <a href="https://www.btob-shop.com/admin/login" target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 transition-colors hover:bg-blue-100">
                    <div>
                      <div className="text-sm font-bold text-blue-800">Bカート管理画面</div>
                      <div className="mt-0.5 text-xs text-blue-500">受注管理・出荷処理はこちらから</div>
                    </div>
                    <span className="text-2xl">📦</span>
                  </a>
                </div>
              </div>

              {/* 右カラム：チャット */}
              <div>
                <WarehouseChat user={user} profile={profile} />
              </div>
            </div>
          </div>
        ) : (
          /* ===== 在庫管理タブ（既存） ===== */
          <>
            {/* サマリー */}
            <div className="mb-4 flex flex-wrap gap-3">
              <div className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
                <div className="text-xs text-gray-500">商品数</div>
                <div className="text-xl font-bold text-gray-900">{totalInWh}</div>
              </div>
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-center">
                <div className="text-xs text-indigo-500">総在庫</div>
                <div className="text-xl font-bold text-indigo-600">{fmtNum(totalStock)}</div>
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-5 py-3 text-center">
                <div className="text-xs text-blue-500">前日比</div>
                {whDiffDay != null ? (
                  <div className={`text-xl font-bold ${whDiffDay > 0 ? 'text-green-600' : whDiffDay < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {whDiffDay > 0 ? '+' : ''}{fmtNum(whDiffDay)}
                  </div>
                ) : <div className="text-xl font-bold text-gray-300">—</div>}
              </div>
              <div className="rounded-xl border border-purple-200 bg-purple-50 px-5 py-3 text-center">
                <div className="text-xs text-purple-500">月初比</div>
                {whDiffMonth != null ? (
                  <div className={`text-xl font-bold ${whDiffMonth > 0 ? 'text-green-600' : whDiffMonth < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                    {whDiffMonth > 0 ? '+' : ''}{fmtNum(whDiffMonth)}
                  </div>
                ) : <div className="text-xl font-bold text-gray-300">—</div>}
              </div>
              {zeroStock > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-center">
                  <div className="text-xs text-red-500">在庫切れ</div>
                  <div className="text-xl font-bold text-red-600">{zeroStock}</div>
                </div>
              )}
              <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-indigo-300 bg-indigo-50 px-5 py-3 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                CSV取込
                <input type="file" accept=".csv" onChange={handleImportCSV} disabled={importing} className="hidden" />
              </label>
              {importMsg && <div className="flex items-center rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">{importMsg}</div>}
            </div>

            {/* 検索 */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input type="text" placeholder="商品名で検索..." value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              {brands.length > 0 && (
                <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">全ブランド</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              {categories.length > 0 && (
                <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">全分類</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              {(brandFilter || catFilter) && (
                <button onClick={() => { setBrandFilter(''); setCatFilter('') }}
                  className="text-sm text-indigo-600 hover:underline">解除</button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              {/* 左：一覧 */}
              <div className="lg:col-span-2">
                <div className="overflow-auto rounded-xl border border-gray-200 bg-white" style={{ maxHeight: 'calc(100vh - 340px)' }}>
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                        <th className="cursor-pointer px-2 py-2" onClick={() => handleSort('no')}>NO{sortIcon('no')}</th>
                        <th className="cursor-pointer px-2 py-2" onClick={() => handleSort('name')}>商品名{sortIcon('name')}</th>
                        <th className="px-2 py-2">容量</th>
                        <th className="px-2 py-2">ブランド</th>
                        <th className="px-2 py-2">分類</th>
                        <th className="cursor-pointer px-2 py-2 text-right" onClick={() => handleSort('stock')}>在庫{sortIcon('stock')}</th>
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
                            <td className="px-2 py-2 font-medium text-gray-900">{p.productName}</td>
                            <td className="px-2 py-2 text-xs text-gray-500">{p.volume || ''}</td>
                            <td className="px-2 py-2">
                              {p.brand && <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeColor(p.brand, brands)}`}>{p.brand}</span>}
                            </td>
                            <td className="px-2 py-2 text-xs text-gray-500">{p.category || ''}</td>
                            <td className="px-2 py-2 text-right">
                              <span className={`font-bold ${isZero ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-gray-900'}`}>{fmtNum(p.stock)}</span>
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
                  {filtered.length === 0 && <div className="py-8 text-center text-sm text-gray-400">この倉庫に商品がありません</div>}
                </div>

                {/* 倉庫ログ */}
                <div className="mt-4 rounded-xl border border-gray-200 bg-white">
                  <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-bold text-gray-600">
                    最近の入出庫・移動ログ
                  </div>
                  <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
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
                              <span className="text-xs text-gray-500">{h.type === 'in' ? '+' : '-'}{h.quantity}</span>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-400">{fmtTime(h.createdAt)}</div>
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
                    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
                      <div className="text-lg font-bold text-gray-900">{selected.productName}</div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {selected.brand && <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor(selected.brand, brands)}`}>{selected.brand}</span>}
                        {selected.category && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{selected.category}</span>}
                      </div>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="text-3xl font-bold text-indigo-600">{fmtNum(selected.stock)}</span>
                        <span className="text-sm text-gray-500">{selected.volume}</span>
                      </div>
                      <div className="mt-3">
                        <button onClick={startEdit}
                          className="w-full rounded-lg border border-indigo-300 bg-indigo-50 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100">編集</button>
                      </div>
                    </div>

                    <div className="mb-3 flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                      {[
                        { key: 'io', label: '入出庫' },
                        { key: 'transfer', label: '他倉庫へ移動' },
                        { key: 'history', label: '履歴' },
                        { key: 'edit', label: '編集' },
                      ].map((t) => (
                        <button key={t.key} onClick={() => { setRightTab(t.key); if (t.key === 'edit') startEdit() }}
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
                        <div className="mb-2 text-xs text-gray-500">現在: <span className="font-medium text-gray-900">{myWarehouse}</span></div>
                        <label className="mb-1 block text-xs text-gray-500">移動先</label>
                        <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)}
                          className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                          <option value="">-- 選択 --</option>
                          {warehouses.filter((w) => w !== myWarehouse).map((w) => <option key={w} value={w}>{w}</option>)}
                        </select>
                        <input type="number" min="1" max={selected.stock || 0} placeholder="移動数量"
                          value={transferQty} onChange={(e) => setTransferQty(e.target.value)}
                          className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        <input type="text" placeholder="備考（任意）" value={transferNote} onChange={(e) => setTransferNote(e.target.value)}
                          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        <button onClick={handleTransfer} disabled={saving || !transferTo || !transferQty}
                          className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                          {saving ? '処理中...' : '移動する'}
                        </button>
                      </div>
                    )}

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
                                <div className="text-[10px] text-gray-400">{fmtTime(h.createdAt)}</div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {rightTab === 'edit' && editing && (
                      <div className="rounded-xl border border-indigo-200 bg-white p-4">
                        <h3 className="mb-3 text-sm font-bold text-indigo-700">商品情報を編集</h3>
                        {renderFormFields(editForm, setEditForm)}
                        <div className="mt-3 flex gap-2">
                          <button onClick={saveEdit} disabled={editSaving}
                            className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
                            {editSaving ? '保存中...' : '保存'}
                          </button>
                          <button onClick={() => { setEditing(false); setRightTab('io') }}
                            className="flex-1 rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
                        </div>
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
          </>
        )}
      </div>
    </div>
  )
}
