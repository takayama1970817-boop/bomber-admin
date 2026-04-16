import { useEffect, useState } from 'react'
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * 未読チャット数をリアルタイムで監視するフック
 *
 * chatRooms ドキュメントの lastMessageAt と _read_{uid} を比較。
 * _read_{uid} が存在しない場合は「既読」扱い（旧データ互換）。
 * 新規メッセージが来た時だけ未読になる。
 */
export function useChatUnread(currentUid) {
  const [totalUnread, setTotalUnread] = useState(0)
  const [rooms, setRooms] = useState([])

  useEffect(() => {
    if (!currentUid) return

    const q = query(
      collection(db, 'chatRooms'),
      orderBy('lastMessageAt', 'desc'),
      limit(50),
    )

    const unsub = onSnapshot(q, (snap) => {
      const results = []
      let total = 0
      const readKey = `_read_${currentUid}`

      for (const roomDoc of snap.docs) {
        const data = roomDoc.data()
        const roomId = roomDoc.id

        if (!isMyRoom(roomId, currentUid)) continue

        const lastMsgAt = data.lastMessageAt?.toMillis?.() || 0

        // _read_ フィールドがない = まだ新方式で既読してない = 既読扱い
        // _read_ フィールドがある = 比較して判定
        let hasUnread = false
        if (readKey in data && data[readKey] !== null) {
          const lastRead = data[readKey]?.toMillis?.() || 0
          hasUnread = lastMsgAt > lastRead
        }
        // _read_ が無い場合は hasUnread = false（既読扱い）

        if (hasUnread) total++

        results.push({
          roomId,
          unread: hasUnread,
          lastMessage: data.lastMessage || '',
        })
      }

      setRooms(results)
      setTotalUnread(total)
    })

    return () => unsub()
  }, [currentUid])

  return { totalUnread, rooms }
}

function isMyRoom(roomId, uid) {
  if (roomId === 'general' || roomId === 'warehouse_chat') return true
  if (roomId === 'dealer_general') return false
  if (roomId.startsWith('dealer_') || roomId.startsWith('salon_')) return true
  if (roomId.includes(uid)) return true
  return false
}
