import { useEffect, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { canManageDocuments, assertCan } from '../lib/permissions.js'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const CATEGORIES = [
  { value: 'catalog', label: '商品カタログ' },
  { value: 'manual', label: 'マニュアル' },
  { value: 'campaign', label: 'キャンペーン' },
  { value: 'other', label: 'その他' },
]

export default function DealerDocManage() {
  const { profile } = useAuth()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)

  // フォーム
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('catalog')
  const [file, setFile] = useState(null)
  const [url, setUrl] = useState('') // 外部URLも引き続き対応
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef(null)

  const fetchDocs = async () => {
    try {
      const snap = await getDocs(
        query(collection(db, 'dealerDocuments'), orderBy('updatedAt', 'desc'))
      )
      setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchDocs() }, [])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setCategory('catalog')
    setFile(null)
    setUrl('')
    setEditing(null)
    setUploadProgress(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const startEdit = (d) => {
    setTitle(d.title || '')
    setDescription(d.description || '')
    setCategory(d.category || 'catalog')
    setUrl(d.url || '')
    setFile(null)
    setEditing(d.id)
    setUploadProgress(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setUrl('') // ファイル選択時はURL欄をクリア
    // タイトルが空ならファイル名をセット
    if (!title.trim()) {
      setTitle(selected.name.replace(/\.[^.]+$/, ''))
    }
  }

  const uploadFile = (f) => {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now()
      const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storageRef = ref(storage, `dealer-docs/${timestamp}_${safeName}`)
      const uploadTask = uploadBytesResumable(storageRef, f)

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
          setUploadProgress(progress)
        },
        (error) => reject(error),
        async () => {
          const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref)
          resolve({
            url: downloadUrl,
            fileName: f.name,
            fileSize: f.size,
            storagePath: storageRef.fullPath,
          })
        },
      )
    })
  }

  const handleSave = async () => {
    // 二重防御：資料管理は admin のみ（canManageDocuments）
    try { assertCan(canManageDocuments, profile) } catch (e) { alert(e.message); return }
    if (!title.trim()) {
      alert('タイトルは必須です')
      return
    }
    if (!file && !url.trim() && !editing) {
      alert('PDFファイルまたはURLを指定してください')
      return
    }

    setSaving(true)
    try {
      let fileData = {}

      // ファイルアップロード
      if (file) {
        fileData = await uploadFile(file)
      }

      const data = {
        title: title.trim(),
        description: description.trim(),
        category,
        updatedAt: serverTimestamp(),
      }

      if (file) {
        data.url = fileData.url
        data.fileName = fileData.fileName
        data.fileSize = fileData.fileSize
        data.storagePath = fileData.storagePath
        data.source = 'upload'
      } else if (url.trim()) {
        data.url = url.trim()
        data.source = 'url'
      }

      if (editing) {
        // 編集時、新しいファイルをアップロードした場合は古いファイルを削除
        if (file) {
          const oldDoc = docs.find((d) => d.id === editing)
          if (oldDoc?.storagePath) {
            try { await deleteObject(ref(storage, oldDoc.storagePath)) } catch { /* ignore */ }
          }
        }
        await updateDoc(doc(db, 'dealerDocuments', editing), data)
      } else {
        data.createdAt = serverTimestamp()
        await addDoc(collection(db, 'dealerDocuments'), data)
      }

      resetForm()
      await fetchDocs()
    } catch (e) {
      console.error(e)
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    // 二重防御：資料削除は admin のみ
    try { assertCan(canManageDocuments, profile) } catch (e) { alert(e.message); return }
    if (!confirm('この資料を削除しますか？')) return
    try {
      // Storage のファイルも削除
      const target = docs.find((d) => d.id === id)
      if (target?.storagePath) {
        try { await deleteObject(ref(storage, target.storagePath)) } catch { /* ignore */ }
      }
      await deleteDoc(doc(db, 'dealerDocuments', id))
      await fetchDocs()
    } catch (e) {
      alert('削除に失敗しました')
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">代理店向け資料管理</h1>
      <p className="mb-6 text-sm text-gray-500">
        PDFをアップロードするか、外部URLを登録できます
      </p>

      {/* 登録/編集フォーム */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold text-gray-700">
          {editing ? '資料を編集' : '資料を追加'}
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-gray-500">タイトル（必須）</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：2026年春キャンペーン資料"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">カテゴリ</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          {/* PDFアップロード */}
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-gray-500">PDFファイル</label>
            <div className="flex items-center gap-3">
              <label className="cursor-pointer rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 transition-colors hover:border-indigo-400 hover:text-indigo-600">
                ファイルを選択
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.PDF"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
              {file && (
                <div className="flex items-center gap-2">
                  <span className="rounded bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700">
                    {file.name}
                  </span>
                  <span className="text-xs text-gray-400">{fmtSize(file.size)}</span>
                  <button
                    onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
            {uploadProgress > 0 && uploadProgress < 100 && (
              <div className="mt-2">
                <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-gray-400">{uploadProgress}%</div>
              </div>
            )}
          </div>

          {/* 外部URL（ファイル未選択時のみ） */}
          {!file && (
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs text-gray-500">
                または外部URL{editing ? '' : '（ファイル未選択時）'}
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://drive.google.com/..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
          )}

          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-gray-500">説明（任意）</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="資料の説明"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="mt-4 flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {saving ? (uploadProgress > 0 && uploadProgress < 100 ? `アップロード中... ${uploadProgress}%` : '保存中...') : editing ? '更新する' : '追加する'}
          </button>
          {editing && (
            <button
              onClick={resetForm}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              キャンセル
            </button>
          )}
        </div>
      </div>

      {/* 一覧 */}
      <h2 className="mb-3 text-sm font-bold text-gray-700">登録済み資料（{docs.length}件）</h2>
      {docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          資料がまだ登録されていません
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-3">タイトル</th>
                <th className="px-4 py-3">カテゴリ</th>
                <th className="px-4 py-3">種類</th>
                <th className="px-4 py-3">更新日</th>
                <th className="px-4 py-3 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{d.title}</div>
                    {d.description && (
                      <div className="mt-0.5 text-xs text-gray-400">{d.description}</div>
                    )}
                    {d.fileName && (
                      <div className="mt-0.5 text-xs text-gray-400">
                        {d.fileName}{d.fileSize ? ` (${fmtSize(d.fileSize)})` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {CATEGORIES.find((c) => c.value === d.category)?.label || d.category}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                      d.source === 'upload'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-blue-100 text-blue-700'
                    }`}>
                      {d.source === 'upload' ? 'PDF' : 'URL'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(d.updatedAt)}</td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center gap-2">
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                      >
                        開く
                      </a>
                      <button
                        onClick={() => startEdit(d)}
                        className="rounded bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-200"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDelete(d.id)}
                        className="rounded bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
