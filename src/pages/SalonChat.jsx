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

// companyName をルームID用にサニタイズ（スペースや特殊文字を除去）
function sanitizeForRoomId(str) {
  return (str || '').replace(/[^a-zA-Z0-9\u3000-\u9FFF\uF900-\uFAFF]/g, '_').substring(0, 50)
}

export default function SalonChat() {
  const { user, profile } = useAuth()
  const companyName = profile?.companyName || ''
  const salonName = profile?.salonName || companyName
  const dealerCode = profile?.dealerCode || ''

  const salonKey = sanitizeForRoomId(companyName)
  const hqRoomId = salonKey ? `salon_${salonKey}_hq` : null
  const dealerRoomId = salonKey && dealerCode ? `salon_${salonKey}_${dealerCode}` : null

  const [activeRoom, setActiveRoom] = useState(hqRoomId)
  const [activeRoomName, setActiveRoomName] = useState('ロイヤルトラスト（本社）')
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [readStatus, setReadStatus] = useState({})
  const [attachFile, setAttachFile] = useState(null)
  const [attachPreview, setAttachPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (hqRoomId) setActiveRoom(hqRoomId)
  }, [hqRoomId])

  // メッセージのリアルタイム監視
  useEffect(() => {
    if (!activeRoom) return

    const q = query(
      collection(db, 'chatRooms', activeRoom, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(200),
    )

    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    })

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

  useEffect(() => {
    if (!activeRoom || !user?.uid || messages.length === 0) return
    updateLastRead(activeRoom, user.uid)
  }, [messages.length])

  async function updateLastRead(roomId, uid) {
    try {
      await setDoc(doc(db, 'chatRooms', roomId, 'readers', uid), {
        uid, lastRead: serverTimestamp(),
      }, { merge: true })
    } catch { /* ignore */ }
  }

  // ファイル選択
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
    if (sending || !activeRoom) return
    setSending(true)
    setUploading(!!attachFile)
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

      const displayName = salonName || profile?.name || user.email
      await addDoc(collection(db, 'chatRooms', activeRoom, 'messages'), {
        text: msg,
        uid: user.uid,
        name: displayName,
        createdAt: serverTimestamp(),
        ...(fileData || {}),
      })
      const lastMsg = msg || (fileData ? `📎 ${fileData.fileName}` : '')
      await setDoc(doc(db, 'chatRooms', activeRoom), {
        lastMessage: lastMsg,
        lastMessageAt: serverTimestamp(),
        lastMessageBy: displayName,
      }, { merge: true })
      setText('')
      clearAttach()
      inputRef.current?.focus()
    } catch (e) {
      console.error(e)
      alert('送信に失敗しました')
    } finally {
      setSending(false)
      setUploading(false)
    }
  }

  const handleDelete = async (msgId) => {
    if (!window.confirm('このメッセージを取り消しますか？')) return
    try {
      await deleteDoc(doc(db, 'chatRooms', activeRoom, 'messages', msgId))
    } catch (e) { console.error(e) }
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

  // 添付ファイル表示
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
            textDecoration: 'none', color: mine ? '#fff' : '#db2777',
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

  if (!hqRoomId) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">チャットが利用できません</div>
        <p className="mt-2 text-sm text-yellow-600">サロン情報が設定されていません。</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 130px)', gap: 0 }}>
      {/* 左: ルーム一覧 */}
      <div style={{
        width: '220px', borderRight: '1px solid #e5e7eb', backgroundColor: '#fff',
        display: 'flex', flexDirection: 'column', flexShrink: 0,
      }}>
        <div style={{ padding: '16px', borderBottom: '1px solid #e5e7eb', fontSize: '14px', fontWeight: 'bold', color: '#111' }}>
          チャット
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* 本社チャット */}
          <div
            onClick={() => switchRoom(hqRoomId, 'ロイヤルトラスト（本社）')}
            style={{
              padding: '12px 16px', cursor: 'pointer',
              backgroundColor: activeRoom === hqRoomId ? '#fdf2f8' : 'transparent',
              borderBottom: '1px solid #f3f4f6',
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#111' }}>
              ロイヤルトラスト（本社）
            </div>
            <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
              本社との連絡
            </div>
          </div>

          {/* 代理店チャット */}
          {dealerRoomId && (
            <div
              onClick={() => switchRoom(dealerRoomId, '担当代理店')}
              style={{
                padding: '12px 16px', cursor: 'pointer',
                backgroundColor: activeRoom === dealerRoomId ? '#fdf2f8' : 'transparent',
                borderBottom: '1px solid #f3f4f6',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: '600', color: '#111' }}>
                担当代理店
              </div>
              <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                代理店との連絡
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右: メッセージエリア */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#f9fafb' }}>
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#fff',
          fontSize: '15px', fontWeight: 'bold', color: '#111',
        }}>
          {activeRoomName}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#aaa', marginTop: '80px', fontSize: '13px' }}>
              まだメッセージがありません
            </div>
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
                    backgroundColor: mine ? '#db2777' : '#e5e7eb',
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
                    <div style={{ fontSize: '11px', color: mine ? '#db2777' : '#888', marginBottom: '3px' }}>
                      {msg.name}
                    </div>
                    <div style={{
                      display: 'flex', flexDirection: mine ? 'row-reverse' : 'row',
                      alignItems: 'center', gap: '6px',
                    }}>
                      <div style={{
                        padding: '10px 14px',
                        borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        backgroundColor: mine ? '#db2777' : '#fff',
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
                          onClick={() => handleDelete(msg.id)}
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
                        <span style={{ color: '#db2777', fontWeight: '600' }}>既読</span>
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
              backgroundColor: (text.trim() || attachFile) ? '#db2777' : '#d1d5db',
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
