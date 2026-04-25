import { useEffect, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import {
  canSendMessage,
  canDeleteOwnChatMessage,
  canManageChatRoom,
  assertCan,
} from '../lib/permissions.js'
// 横展開 Phase 4（2026-04-25）: 共通 UI 部品
import { LoadingSkeleton, ErrorBanner, EmptyStateCard } from '../components/common/index.js'

function fmtTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  return `${d.getMonth() + 1}/${d.getDate()} ` + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

export default function DealerChat() {
  const { user, profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''
  const companyName = profile?.companyName || ''

  const [activeRoom, setActiveRoom] = useState(`dealer_${dealerCode}`)
  const [activeRoomName, setActiveRoomName] = useState('ロイヤルトラスト')
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [readStatus, setReadStatus] = useState({})
  const [attachFile, setAttachFile] = useState(null)
  const [attachPreview, setAttachPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  // 横展開 Phase 4: 初回ロード判定 + alert 置換用エラー
  const [initialLoading, setInitialLoading] = useState(true)
  const [chatError, setChatError] = useState(null)
  // モバイル: 左ペイン（ルーム一覧）の表示制御
  const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  // ルーム初期値
  useEffect(() => {
    if (dealerCode) setActiveRoom(`dealer_${dealerCode}`)
  }, [dealerCode])

  // メッセージのリアルタイム監視
  useEffect(() => {
    if (!activeRoom) return
    setInitialLoading(true)
    setChatError(null)

    const q = query(
      collection(db, 'chatRooms', activeRoom, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(200),
    )

    const unsub = onSnapshot(
      q,
      (snap) => {
        setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setInitialLoading(false)
        setChatError(null)
        setTimeout(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      },
      (err) => {
        console.error('chat onSnapshot error:', err)
        setInitialLoading(false)
        setChatError(err?.message || 'メッセージの取得に失敗しました')
      },
    )

    // 既読更新
    if (user?.uid) updateLastRead(activeRoom, user.uid)

    return () => unsub()
  }, [activeRoom, user])

  // 既読状態の監視
  useEffect(() => {
    if (!activeRoom) return
    const unsub = onSnapshot(
      collection(db, 'chatRooms', activeRoom, 'readers'),
      (snap) => {
        const status = {}
        snap.forEach((d) => {
          const data = d.data()
          status[d.id] = data.lastRead?.toMillis?.() || 0
        })
        setReadStatus(status)
      },
    )
    return () => unsub()
  }, [activeRoom])

  // メッセージ追加時に既読更新
  useEffect(() => {
    if (!activeRoom || !user?.uid || messages.length === 0) return
    updateLastRead(activeRoom, user.uid)
  }, [messages.length])

  async function updateLastRead(roomId, uid) {
    try {
      const readerRef = doc(db, 'chatRooms', roomId, 'readers', uid)
      await setDoc(readerRef, { uid, lastRead: serverTimestamp() }, { merge: true })
    } catch { /* ignore */ }
  }

  // ファイル選択
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setChatError('ファイルサイズは10MB以下にしてください')
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
    // 二重防御：送信はログイン済みなら誰でも可
    try { assertCan(canSendMessage, profile) } catch (e) { setChatError(e.message); return }
    setSending(true)
    setUploading(!!attachFile)
    setChatError(null)
    try {
      let fileData = null
      if (attachFile) {
        const ts = Date.now()
        const safeName = attachFile.name.replace(/[^a-zA-Z0-9._\-\u3000-\u9FFF]/g, '_')
        const path = `chat/${activeRoom}/${ts}_${safeName}`
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

      const displayName = companyName || profile?.name || user.email
      await addDoc(collection(db, 'chatRooms', activeRoom, 'messages'), {
        text: msg,
        uid: user.uid,
        name: displayName,
        createdAt: serverTimestamp(),
        ...(fileData || {}),
      })
      const lastMsg = msg || (fileData ? `📎 ${fileData.fileName}` : '')
      await setDoc(
        doc(db, 'chatRooms', activeRoom),
        { lastMessage: lastMsg, lastMessageAt: serverTimestamp(), lastMessageBy: displayName },
        { merge: true },
      )
      setText('')
      clearAttach()
      inputRef.current?.focus()
    } catch (e) {
      console.error(e)
      setChatError(`送信に失敗しました: ${e?.message || e}`)
    } finally {
      setSending(false)
      setUploading(false)
    }
  }

  const handleDelete = async (msg) => {
    // 二重防御：自分のメッセージなら canDeleteOwnChatMessage、他人のは canManageChatRoom
    const isMine = msg?.uid === user?.uid
    try {
      if (isMine) {
        assertCan(canDeleteOwnChatMessage, profile)
      } else {
        assertCan(canManageChatRoom, profile, {
          userMessage: '他人のメッセージは管理者のみ削除できます',
        })
      }
    } catch (e) {
      setChatError(e.message); return
    }
    if (!window.confirm('このメッセージを取り消しますか？')) return
    try {
      await deleteDoc(doc(db, 'chatRooms', activeRoom, 'messages', msg.id))
    } catch (e) {
      console.error('メッセージ削除失敗:', e)
      setChatError(`削除に失敗しました: ${e?.message || e}`)
    }
  }

  const switchRoom = (roomId, name) => {
    setActiveRoom(roomId)
    setActiveRoomName(name)
    setMessages([])
    if (user?.uid) updateLastRead(roomId, user.uid)
  }

  const isMyMessage = (msg) => msg.uid === user?.uid

  const isReadByOthers = (msg) => {
    if (!isMyMessage(msg)) return false
    const msgTime = msg.createdAt?.toMillis?.() || 0
    if (!msgTime) return false
    return Object.entries(readStatus).some(
      ([uid, lastRead]) => uid !== user?.uid && lastRead >= msgTime,
    )
  }

  // 添付ファイル表示コンポーネント
  const FileAttachment = ({ msg, mine }) => (
    <>
      {msg.fileUrl && msg.fileType?.startsWith('image/') && (
        <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: msg.text ? '8px' : 0 }}>
          <img src={msg.fileUrl} alt={msg.fileName}
            style={{ maxWidth: '240px', maxHeight: '200px', borderRadius: '8px', cursor: 'pointer' }} />
        </a>
      )}
      {msg.fileUrl && !msg.fileType?.startsWith('image/') && (
        <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 12px', borderRadius: '8px',
            backgroundColor: mine ? 'rgba(255,255,255,0.15)' : '#f3f4f6',
            textDecoration: 'none', color: mine ? '#fff' : '#4f46e5',
            marginBottom: msg.text ? '8px' : 0, fontSize: '13px',
          }}>
          <span>📎</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {msg.fileName || 'ファイル'}
          </span>
          {msg.fileSize && <span style={{ fontSize: '11px', opacity: 0.7, flexShrink: 0 }}>{fmtSize(msg.fileSize)}</span>}
        </a>
      )}
    </>
  )

  return (
    // 横展開 Phase 4: モバイル対応のため 100dvh ベース + flex-col(モバイル) / flex-row(PC)
    // 100dvh は iOS Safari の動的ビューポート対応（旧 100vh はアドレスバー分が崩れる）
    <div className="flex h-[calc(100dvh-130px)] flex-col md:flex-row md:gap-0">
      {/* モバイル用ヘッダー（≤ md）: ルーム名 + サイドバー切替 */}
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 md:hidden">
        <button
          onClick={() => setSidebarOpenMobile((v) => !v)}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
        >
          ☰ ルーム
        </button>
        <div className="text-sm font-bold text-gray-900">{activeRoomName}</div>
        <div className="w-12" />
      </div>

      {/* 左: ルーム一覧（PC は常時表示、モバイルは sidebarOpenMobile=true のときだけ） */}
      <div
        className={`${sidebarOpenMobile ? 'flex' : 'hidden'} md:flex w-full md:w-[220px] flex-shrink-0 flex-col border-b border-gray-200 bg-white md:border-b-0 md:border-r`}
      >
        <div className="hidden border-b border-gray-200 px-4 py-4 text-sm font-bold text-gray-900 md:block">
          チャット
        </div>
        <div className="flex-1 overflow-auto">
          {/* 個別チャット */}
          <div
            onClick={() => {
              switchRoom(`dealer_${dealerCode}`, 'ロイヤルトラスト')
              setSidebarOpenMobile(false)
            }}
            className={`cursor-pointer border-b border-gray-100 px-4 py-3 ${activeRoom === `dealer_${dealerCode}` ? 'bg-indigo-50' : ''}`}
          >
            <div className="text-sm font-semibold text-gray-900">ロイヤルトラスト</div>
            <div className="mt-0.5 text-[11px] text-gray-500">個別チャット</div>
          </div>
        </div>
      </div>

      {/* 右: メッセージエリア */}
      <div className="flex flex-1 flex-col bg-gray-50">
        {/* PC のみルーム名ヘッダ。モバイルは上の切替バーが代替 */}
        <div className="hidden border-b border-gray-200 bg-white px-5 py-3 text-base font-bold text-gray-900 md:block">
          {activeRoomName}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {initialLoading ? (
            <LoadingSkeleton variant="card" lines={3} label="メッセージを読み込み中…" />
          ) : messages.length === 0 ? (
            <EmptyStateCard
              icon="💬"
              title="まだメッセージがありません"
              description="下の入力欄からメッセージを送信してください。"
            />
          ) : (
            messages.map((msg) => {
              const mine = isMyMessage(msg)
              const initial = (msg.name || '?')[0]
              return (
                <div key={msg.id} style={{
                  marginBottom: '14px', display: 'flex',
                  flexDirection: mine ? 'row-reverse' : 'row',
                  alignItems: 'flex-start', gap: '8px',
                }}>
                  <div style={{
                    width: '34px', height: '34px', borderRadius: '50%',
                    backgroundColor: mine ? '#4f46e5' : '#e5e7eb',
                    color: mine ? '#fff' : '#555',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', fontWeight: 'bold', flexShrink: 0,
                  }}>
                    {initial}
                  </div>
                  <div style={{
                    maxWidth: '65%', display: 'flex', flexDirection: 'column',
                    alignItems: mine ? 'flex-end' : 'flex-start',
                  }}>
                    <div style={{ fontSize: '11px', color: mine ? '#6366f1' : '#888', marginBottom: '3px' }}>
                      {msg.name}
                    </div>
                    <div style={{
                      display: 'flex', flexDirection: mine ? 'row-reverse' : 'row',
                      alignItems: 'center', gap: '6px',
                    }}>
                      <div style={{
                        padding: '10px 14px',
                        borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        backgroundColor: mine ? '#4f46e5' : '#fff',
                        color: mine ? '#fff' : '#111',
                        fontSize: '14px', lineHeight: '1.5',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        <FileAttachment msg={msg} mine={mine} />
                        {msg.text}
                      </div>
                      {mine && (
                        <button
                          onClick={() => handleDelete(msg)}
                          style={{
                            background: '#fee2e2', border: '1px solid #fca5a5', color: '#dc2626',
                            cursor: 'pointer', fontSize: '11px', fontWeight: 'bold',
                            padding: '4px 8px', borderRadius: '6px', lineHeight: 1,
                            flexShrink: 0, whiteSpace: 'nowrap',
                          }}
                        >
                          取消
                        </button>
                      )}
                    </div>
                    <div style={{
                      fontSize: '10px', color: '#bbb', marginTop: '3px',
                      display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                      {mine && isReadByOthers(msg) && (
                        <span style={{ color: '#4f46e5', fontWeight: '600' }}>既読</span>
                      )}
                      {fmtTime(msg.createdAt)}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* エラーバナー（送信失敗 / アップロード超過 / Realtime 失敗） */}
        {chatError && (
          <div className="px-3 pt-2">
            <ErrorBanner message={chatError} onRetry={() => setChatError(null)} retryLabel="閉じる" />
          </div>
        )}

        {/* 添付プレビュー */}
        {attachFile && (
          <div style={{ padding: '8px 20px 0', backgroundColor: '#fff', borderTop: '1px solid #e5e7eb' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              padding: '6px 12px', borderRadius: '8px', backgroundColor: '#f3f4f6',
              fontSize: '13px', color: '#333',
            }}>
              {attachPreview ? (
                <img src={attachPreview} alt="" style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '6px' }} />
              ) : <span>📎</span>}
              <span style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {attachFile.name}
              </span>
              <span style={{ fontSize: '11px', color: '#888' }}>{fmtSize(attachFile.size)}</span>
              <button onClick={clearAttach} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '16px', color: '#999', padding: '0 2px', lineHeight: 1,
              }}>×</button>
            </div>
          </div>
        )}

        {/* 入力エリア */}
        <div style={{
          padding: '12px 20px', borderTop: attachFile ? 'none' : '1px solid #e5e7eb', backgroundColor: '#fff',
          display: 'flex', gap: '10px', alignItems: 'center',
        }}>
          <input ref={fileInputRef} type="file" onChange={handleFileSelect} style={{ display: 'none' }}
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="ファイルを添付"
            style={{
              background: 'none', border: '1px solid #d1d5db', borderRadius: '10px',
              padding: '9px 12px', cursor: 'pointer', fontSize: '16px',
              color: '#6b7280', display: 'flex', alignItems: 'center', flexShrink: 0,
            }}
          >
            📎
          </button>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
            }}
            placeholder={uploading ? 'アップロード中...' : 'メッセージを入力...'}
            disabled={uploading}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: '10px',
              border: '1px solid #d1d5db', fontSize: '14px', outline: 'none',
            }}
          />
          <button
            onClick={handleSend}
            disabled={(!text.trim() && !attachFile) || sending}
            style={{
              padding: '10px 20px', borderRadius: '10px', border: 'none',
              backgroundColor: (text.trim() || attachFile) ? '#4f46e5' : '#d1d5db',
              color: '#fff', fontSize: '14px', fontWeight: 'bold',
              cursor: (text.trim() || attachFile) ? 'pointer' : 'default',
            }}
          >
            {uploading ? '送信中...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}
