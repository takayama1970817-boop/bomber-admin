import { useEffect, useRef, useState } from 'react'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
// canSendMessage: チャット送信（全員OK）
// canManageChatRoom: 部屋作成・削除・メンバー変更（admin のみ、将来の部屋管理UI向け）
// TODO(future): 部屋作成/メンバー管理画面を実装する際に canManageChatRoom を配線する
import { canSendMessage, assertCan } from '../lib/permissions.js'

// DM の roomId を一意に決める（uid をソートして結合）
function dmRoomId(uid1, uid2) {
  return [uid1, uid2].sort().join('_')
}

// サロンのルームID用サニタイズ（SalonChat.jsx と同じロジック）
function sanitizeForRoomId(str) {
  return (str || '').replace(/[^a-zA-Z0-9\u3000-\u9FFF\uF900-\uFAFF]/g, '_').substring(0, 50)
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  }
  return (
    `${d.getMonth() + 1}/${d.getDate()} ` +
    d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  )
}

export default function Chat() {
  const { user, profile } = useAuth()
  const [users, setUsers] = useState([])
  const [activeRoom, setActiveRoom] = useState('general') // 'general' or dmRoomId
  const [activeRoomName, setActiveRoomName] = useState('全体チャット')
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState({})
  const [readStatus, setReadStatus] = useState({}) // { uid: lastReadMillis }
  const [attachFile, setAttachFile] = useState(null)
  const [attachPreview, setAttachPreview] = useState(null)
  const [uploading, setUploading] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)

  const [dealerAccounts, setDealerAccounts] = useState([])
  const [salonAccounts, setSalonAccounts] = useState([])

  // スタッフ一覧 + 代理店一覧 + サロン一覧を取得
  useEffect(() => {
    ;(async () => {
      try {
        const [userSnap, emailSnap] = await Promise.all([
          getDocs(collection(db, 'users')),
          getDocs(collection(db, 'allowedEmails')),
        ])
        setUsers(
          userSnap.docs
            .map((d) => ({ uid: d.id, ...d.data() }))
            .filter((u) => u.uid !== user?.uid),
        )
        const allEmails = emailSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        setDealerAccounts(
          allEmails.filter((d) => d.role === 'dealer' && d.dealerCode),
        )
        setSalonAccounts(
          allEmails.filter((d) => d.role === 'salon' && d.companyName),
        )
      } catch (e) {
        console.error('ユーザー一覧の取得に失敗:', e)
      }
    })()
  }, [user])

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
      // 少し待ってからスクロール
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
      // メッセージが来るたびに既読を更新
      if (user?.uid) {
        updateLastRead(activeRoom, user.uid)
      }
    })

    return () => unsub()
  }, [activeRoom, user])

  // readers（既読状態）をリアルタイム監視
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

  // 未読数の監視（全ルーム）
  useEffect(() => {
    if (!user?.uid) return

    const dealerRooms = dealerAccounts.map((d) => `dealer_${d.dealerCode}`)
    const salonRooms = salonAccounts.map((s) => `salon_${sanitizeForRoomId(s.companyName)}_hq`)
    const rooms = ['general', 'warehouse_chat', ...dealerRooms, ...salonRooms, ...users.map((u) => dmRoomId(user.uid, u.uid))]
    const unsubs = rooms.map((roomId) => {
      const q = query(
        collection(db, 'chatRooms', roomId, 'messages'),
        orderBy('createdAt', 'desc'),
        limit(1),
      )
      return onSnapshot(q, async (snap) => {
        if (snap.empty) return
        const lastMsg = snap.docs[0].data()
        const lastMsgTime = lastMsg.createdAt?.toMillis?.() || 0

        // lastRead を取得
        try {
          const roomDoc = await getDocs(
            query(
              collection(db, 'chatRooms', roomId, 'readers'),
              where('uid', '==', user.uid),
              limit(1),
            ),
          ).catch(() => null)

          let lastRead = 0
          if (roomDoc && !roomDoc.empty) {
            lastRead = roomDoc.docs[0].data().lastRead?.toMillis?.() || 0
          }

          if (lastMsgTime > lastRead && roomId !== activeRoom) {
            setUnreadCounts((prev) => ({ ...prev, [roomId]: true }))
          } else {
            setUnreadCounts((prev) => ({ ...prev, [roomId]: false }))
          }
        } catch {
          // ignore
        }
      })
    })

    return () => unsubs.forEach((u) => u())
  }, [user, users, activeRoom])

  async function updateLastRead(roomId, uid) {
    try {
      const now = Timestamp.now()
      // 既読時刻を chatRooms ドキュメントに直接書く（onSnapshot で即検知）
      // Timestamp.now() を使う（serverTimestamp() はローカル snapshot で null になるため）
      await setDoc(doc(db, 'chatRooms', roomId), {
        [`_read_${uid}`]: now,
      }, { merge: true })
      // readers サブコレクションにも書く（既読表示用）
      const readerRef = doc(db, 'chatRooms', roomId, 'readers', uid)
      await setDoc(readerRef, { uid, lastRead: now }, { merge: true })
      setUnreadCounts((prev) => ({ ...prev, [roomId]: false }))
    } catch (e) {
      console.error('既読更新エラー:', e)
    }
  }

  // メッセージが追加されるたびに、開いているルームの既読を更新
  useEffect(() => {
    if (!activeRoom || !user?.uid || messages.length === 0) return
    updateLastRead(activeRoom, user.uid)
  }, [messages.length])

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

  // ファイルサイズ表示
  const fmtSize = (bytes) => {
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  }

  const handleSend = async () => {
    const msg = text.trim()
    if (!msg && !attachFile) return
    if (sending) return

    // 二重防御：保存処理側で権限チェック（canSendMessage = ログイン済みなら全員OK）
    try {
      assertCan(canSendMessage, profile, {
        userMessage: 'チャット送信権限がありません。ログインし直してください。',
      })
    } catch (e) {
      alert(e.message)
      return
    }

    setSending(true)
    setUploading(!!attachFile)
    try {
      let fileData = null

      // ファイルアップロード
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

      const msgDoc = {
        text: msg,
        uid: user.uid,
        name: profile?.name || user.email,
        createdAt: serverTimestamp(),
        ...(fileData || {}),
      }

      await addDoc(collection(db, 'chatRooms', activeRoom, 'messages'), msgDoc)

      // ルームの最終メッセージを更新
      const lastMsg = msg || (fileData ? `📎 ${fileData.fileName}` : '')
      await setDoc(
        doc(db, 'chatRooms', activeRoom),
        {
          lastMessage: lastMsg,
          lastMessageAt: serverTimestamp(),
          lastMessageBy: profile?.name || user.email,
        },
        { merge: true },
      )

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

  const switchRoom = (roomId, name) => {
    setActiveRoom(roomId)
    setActiveRoomName(name)
    setMessages([])
    if (user?.uid) updateLastRead(roomId, user.uid)
  }

  const isMyMessage = (msg) => msg.uid === user?.uid

  const handleDelete = async (msgId) => {
    if (!window.confirm('このメッセージを取り消しますか？')) return
    try {
      await deleteDoc(doc(db, 'chatRooms', activeRoom, 'messages', msgId))
    } catch (e) {
      console.error(e)
      alert('取り消しに失敗しました')
    }
  }

  // 自分のメッセージを相手が既読したかチェック
  const isReadByOthers = (msg) => {
    if (!isMyMessage(msg)) return false
    const msgTime = msg.createdAt?.toMillis?.() || 0
    if (!msgTime) return false
    // 自分以外の誰かが、このメッセージの時刻以降に既読している
    return Object.entries(readStatus).some(
      ([uid, lastRead]) => uid !== user?.uid && lastRead >= msgTime,
    )
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)', gap: 0 }}>
      {/* 左: ルーム一覧 */}
      <div
        style={{
          width: '240px',
          borderRight: '1px solid #e5e7eb',
          backgroundColor: '#fff',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '16px',
            borderBottom: '1px solid #e5e7eb',
            fontSize: '14px',
            fontWeight: 'bold',
            color: '#111',
          }}
        >
          チャット
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {/* 全体チャット */}
          <div
            onClick={() => switchRoom('general', '全体チャット')}
            style={{
              padding: '12px 16px',
              cursor: 'pointer',
              backgroundColor: activeRoom === 'general' ? '#eef2ff' : 'transparent',
              borderBottom: '1px solid #f3f4f6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: '13px', fontWeight: '600', color: '#111' }}>
                📢 全体チャット
              </div>
              <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                全スタッフ共通
              </div>
            </div>
            {unreadCounts['general'] && (
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: '#ef4444',
                  flexShrink: 0,
                }}
              />
            )}
          </div>

          {/* 倉庫連絡チャット */}
          <div
            onClick={() => switchRoom('warehouse_chat', '📦 倉庫連絡')}
            style={{
              padding: '12px 16px',
              cursor: 'pointer',
              backgroundColor: activeRoom === 'warehouse_chat' ? '#eef2ff' : 'transparent',
              borderBottom: '1px solid #f3f4f6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: '13px', fontWeight: '600', color: '#111' }}>
                📦 倉庫連絡
              </div>
              <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                OHC倉庫との業務連絡
              </div>
            </div>
            {unreadCounts['warehouse_chat'] && (
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: '#ef4444',
                  flexShrink: 0,
                }}
              />
            )}
          </div>

          {/* 代理店チャット */}
          {dealerAccounts.length > 0 && (
            <>
              <div
                style={{
                  padding: '10px 16px 6px',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: '#888',
                  textTransform: 'uppercase',
                }}
              >
                代理店チャット
              </div>
              {dealerAccounts.map((d) => {
                const roomId = `dealer_${d.dealerCode}`
                return (
                  <div
                    key={d.id}
                    onClick={() => switchRoom(roomId, d.companyName || d.dealerCode)}
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      backgroundColor: activeRoom === roomId ? '#eef2ff' : 'transparent',
                      borderBottom: '1px solid #f9fafb',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ fontSize: '13px', color: '#333' }}>
                      {d.companyName || d.dealerCode}
                    </div>
                    {unreadCounts[roomId] && (
                      <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#ef4444', flexShrink: 0 }} />
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* サロンチャット */}
          {salonAccounts.length > 0 && (
            <>
              <div
                style={{
                  padding: '10px 16px 6px',
                  fontSize: '11px',
                  fontWeight: '600',
                  color: '#888',
                  textTransform: 'uppercase',
                }}
              >
                サロンチャット
              </div>
              {salonAccounts.map((s) => {
                const roomId = `salon_${sanitizeForRoomId(s.companyName)}_hq`
                return (
                  <div
                    key={s.id}
                    onClick={() => switchRoom(roomId, s.companyName || s.salonName)}
                    style={{
                      padding: '10px 16px',
                      cursor: 'pointer',
                      backgroundColor: activeRoom === roomId ? '#eef2ff' : 'transparent',
                      borderBottom: '1px solid #f9fafb',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ fontSize: '13px', color: '#333' }}>
                      {s.companyName || s.salonName}
                    </div>
                    {unreadCounts[roomId] && (
                      <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#ef4444', flexShrink: 0 }} />
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* DM一覧 */}
          <div
            style={{
              padding: '10px 16px 6px',
              fontSize: '11px',
              fontWeight: '600',
              color: '#888',
              textTransform: 'uppercase',
            }}
          >
            ダイレクトメッセージ
          </div>
          {users.map((u) => {
            const roomId = dmRoomId(user.uid, u.uid)
            return (
              <div
                key={u.uid}
                onClick={() => switchRoom(roomId, u.name || u.email)}
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  backgroundColor: activeRoom === roomId ? '#eef2ff' : 'transparent',
                  borderBottom: '1px solid #f9fafb',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ fontSize: '13px', color: '#333' }}>
                  {u.name || u.email}
                </div>
                {unreadCounts[roomId] && (
                  <div
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      backgroundColor: '#ef4444',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 右: メッセージエリア */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#f9fafb',
        }}
      >
        {/* ヘッダー */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid #e5e7eb',
            backgroundColor: '#fff',
            fontSize: '15px',
            fontWeight: 'bold',
            color: '#111',
          }}
        >
          {activeRoomName}
        </div>

        {/* メッセージ一覧 */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px 20px',
          }}
        >
          {messages.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                color: '#aaa',
                marginTop: '80px',
                fontSize: '13px',
              }}
            >
              まだメッセージがありません
            </div>
          ) : (
            messages.map((msg) => {
              const mine = isMyMessage(msg)
              const initial = (msg.name || '?')[0]
              return (
                <div
                  key={msg.id}
                  style={{
                    marginBottom: '14px',
                    display: 'flex',
                    flexDirection: mine ? 'row-reverse' : 'row',
                    alignItems: 'flex-start',
                    gap: '8px',
                  }}
                >
                  {/* アバター */}
                  <div
                    style={{
                      width: '34px',
                      height: '34px',
                      borderRadius: '50%',
                      backgroundColor: mine ? '#4f46e5' : '#e5e7eb',
                      color: mine ? '#fff' : '#555',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '13px',
                      fontWeight: 'bold',
                      flexShrink: 0,
                    }}
                  >
                    {initial}
                  </div>

                  {/* メッセージ本体 */}
                  <div
                    style={{
                      maxWidth: '65%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: mine ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '11px',
                        color: mine ? '#6366f1' : '#888',
                        marginBottom: '3px',
                      }}
                    >
                      {msg.name}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: mine ? 'row-reverse' : 'row',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <div
                        style={{
                          padding: '10px 14px',
                          borderRadius: mine
                            ? '16px 16px 4px 16px'
                            : '16px 16px 16px 4px',
                          backgroundColor: mine ? '#4f46e5' : '#fff',
                          color: mine ? '#fff' : '#111',
                          fontSize: '14px',
                          lineHeight: '1.5',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {/* 画像添付 */}
                        {msg.fileUrl && msg.fileType?.startsWith('image/') && (
                          <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: msg.text ? '8px' : 0 }}>
                            <img src={msg.fileUrl} alt={msg.fileName}
                              style={{ maxWidth: '240px', maxHeight: '200px', borderRadius: '8px', cursor: 'pointer' }} />
                          </a>
                        )}
                        {/* ファイル添付（画像以外） */}
                        {msg.fileUrl && !msg.fileType?.startsWith('image/') && (
                          <a href={msg.fileUrl} target="_blank" rel="noopener noreferrer"
                            style={{
                              display: 'flex', alignItems: 'center', gap: '8px',
                              padding: '8px 12px', borderRadius: '8px',
                              backgroundColor: mine ? 'rgba(255,255,255,0.15)' : '#f3f4f6',
                              textDecoration: 'none', color: mine ? '#fff' : '#4f46e5',
                              marginBottom: msg.text ? '8px' : 0,
                              fontSize: '13px',
                            }}>
                            <span>📎</span>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {msg.fileName || 'ファイル'}
                            </span>
                            {msg.fileSize && <span style={{ fontSize: '11px', opacity: 0.7, flexShrink: 0 }}>{fmtSize(msg.fileSize)}</span>}
                          </a>
                        )}
                        {msg.text}
                      </div>
                      {mine && (
                        <button
                          onClick={() => handleDelete(msg.id)}
                          style={{
                            background: '#fee2e2',
                            border: '1px solid #fca5a5',
                            color: '#dc2626',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            lineHeight: 1,
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          取消
                        </button>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: '10px',
                        color: '#bbb',
                        marginTop: '3px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
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
              ) : (
                <span>📎</span>
              )}
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
        <div
          style={{
            padding: '12px 20px',
            borderTop: attachFile ? 'none' : '1px solid #e5e7eb',
            backgroundColor: '#fff',
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
          }}
        >
          <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden" style={{ display: 'none' }}
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="ファイルを添付"
            style={{
              background: 'none', border: '1px solid #d1d5db', borderRadius: '10px',
              padding: '9px 12px', cursor: 'pointer', fontSize: '16px',
              color: '#6b7280', display: 'flex', alignItems: 'center',
              flexShrink: 0, transition: 'background-color 0.2s',
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#f3f4f6'}
            onMouseLeave={(e) => e.target.style.backgroundColor = 'transparent'}
          >
            📎
          </button>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={uploading ? 'アップロード中...' : 'メッセージを入力...'}
            disabled={uploading}
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleSend}
            disabled={(!text.trim() && !attachFile) || sending}
            style={{
              padding: '10px 20px',
              borderRadius: '10px',
              border: 'none',
              backgroundColor: (text.trim() || attachFile) ? '#4f46e5' : '#d1d5db',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 'bold',
              cursor: (text.trim() || attachFile) ? 'pointer' : 'default',
              transition: 'background-color 0.2s',
            }}
          >
            {uploading ? '送信中...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}
