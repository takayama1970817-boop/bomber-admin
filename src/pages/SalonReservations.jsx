import { useEffect, useMemo, useState } from 'react'
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'

/**
 * サロン側 予約一覧ページ（Phase 1: 閲覧のみ）
 *
 * Square が予約の正本。このページは `reservations` コレクションに
 * 取り込まれた予約を日付順に表示する。
 *
 * Phase 1 スコープ:
 *  - 一覧表示（日付順）
 *  - ステータス表示
 *  - 詳細モーダル（raw JSON 含む）
 *
 * Phase 2 以降:
 *  - 来店登録からの予約選択
 *  - 自社側からの編集・キャンセル
 *  - Webhook 連携
 */

function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}/${m}/${day} ${hh}:${mm}`
}

const STATUS_STYLE = {
  pending:    { label: '仮予約',  className: 'bg-yellow-100 text-yellow-800' },
  confirmed:  { label: '確定',    className: 'bg-green-100 text-green-800' },
  cancelled:  { label: 'キャンセル', className: 'bg-gray-200 text-gray-600 line-through' },
  completed:  { label: '完了',    className: 'bg-blue-100 text-blue-800' },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || { label: status || '—', className: 'bg-gray-100 text-gray-700' }
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${s.className}`}>
      {s.label}
    </span>
  )
}

export default function SalonReservations() {
  const { profile } = useAuth()
  const companyName = profile?.companyName || ''

  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('upcoming') // 'upcoming' | 'past' | 'all'

  const loadReservations = async () => {
    if (!companyName) { setLoading(false); return }
    setLoading(true)
    try {
      const snap = await getDocs(
        query(
          collection(db, 'reservations'),
          where('salonCompanyName', '==', companyName),
          orderBy('startAt', 'desc'),
        ),
      )
      setReservations(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      // インデックス未作成時は orderBy なしで fallback
      console.error('reservations 取得エラー:', e)
      try {
        const snap2 = await getDocs(
          query(
            collection(db, 'reservations'),
            where('salonCompanyName', '==', companyName),
          ),
        )
        setReservations(snap2.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e2) {
        console.error('fallback 取得も失敗:', e2)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadReservations() }, [companyName])

  // フィルタ
  const filtered = useMemo(() => {
    const now = Date.now()
    const toMs = (ts) => ts?.toMillis ? ts.toMillis() : (ts ? new Date(ts).getTime() : 0)
    let list = [...reservations]
    if (filter === 'upcoming') {
      list = list.filter((r) => toMs(r.startAt) >= now)
    } else if (filter === 'past') {
      list = list.filter((r) => toMs(r.startAt) < now)
    }
    // startAt 昇順に並べ替え（近い未来が上）
    list.sort((a, b) => toMs(a.startAt) - toMs(b.startAt))
    return list
  }, [reservations, filter])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">予約管理</h1>
        <p className="mt-1 text-sm text-gray-500">
          Square予約から自動で取り込まれた予約の一覧です。変更・キャンセルは Square 側で行ってください。
        </p>
      </div>

      {/* フィルタ切替 */}
      <div className="flex gap-2">
        {[
          { v: 'upcoming', l: 'これから' },
          { v: 'past', l: '過去' },
          { v: 'all', l: 'すべて' },
        ].map((f) => (
          <button
            key={f.v}
            onClick={() => setFilter(f.v)}
            className={`rounded-lg px-3 py-2 text-xs font-medium ${
              filter === f.v
                ? 'bg-pink-600 text-white'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {f.l}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          読み込み中…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          {reservations.length === 0
            ? '予約がまだ取り込まれていません。Square側で予約が入ると同期スクリプト実行後にここに表示されます。'
            : 'この条件に一致する予約はありません。'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">日時</th>
                <th className="px-4 py-3 text-left">顧客名</th>
                <th className="px-4 py-3 text-left">メニュー</th>
                <th className="px-4 py-3 text-left">スタッフ</th>
                <th className="px-4 py-3 text-center">ステータス</th>
                <th className="px-4 py-3 text-right">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">{fmtDateTime(r.startAt)}</td>
                  <td className="px-4 py-3">{r.customerName || '—'}</td>
                  <td className="px-4 py-3">{r.menuName || r.menuId || '—'}</td>
                  <td className="px-4 py-3">{r.staffName || r.staffId || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelected(r)}
                      className="text-xs text-pink-600 hover:underline"
                    >
                      詳細
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ReservationDetail reservation={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

function ReservationDetail({ reservation, onClose }) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">予約詳細</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <dl className="space-y-2 text-sm">
          <DetailRow label="ステータス"><StatusBadge status={reservation.status} /></DetailRow>
          <DetailRow label="日時">{fmtDateTime(reservation.startAt)} 〜 {fmtDateTime(reservation.endAt)}</DetailRow>
          <DetailRow label="顧客名">{reservation.customerName || '—'}</DetailRow>
          <DetailRow label="電話番号">{reservation.customerPhone || '—'}</DetailRow>
          <DetailRow label="メール">{reservation.customerEmail || '—'}</DetailRow>
          <DetailRow label="メニュー">{reservation.menuName || reservation.menuId || '—'}</DetailRow>
          <DetailRow label="スタッフ">{reservation.staffName || reservation.staffId || '—'}</DetailRow>
          <DetailRow label="予約番号">
            <code className="text-xs">{reservation.reservationCode || reservation.externalId || '—'}</code>
          </DetailRow>
          {reservation.notes && (
            <DetailRow label="備考">{reservation.notes}</DetailRow>
          )}
          <DetailRow label="取込元">{reservation.source || '—'}</DetailRow>
        </dl>

        <div className="mt-4">
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-xs text-gray-500 hover:text-gray-700 hover:underline"
          >
            {showRaw ? '▲ Square 元データを隠す' : '▼ Square 元データを表示'}
          </button>
          {showRaw && (
            <pre className="mt-2 overflow-auto rounded bg-gray-50 p-3 text-[11px] text-gray-700">
              {JSON.stringify(reservation.raw || {}, null, 2)}
            </pre>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, children }) {
  return (
    <div className="flex items-start gap-3 border-b border-gray-100 py-2 last:border-b-0">
      <dt className="w-24 shrink-0 text-xs font-medium text-gray-500">{label}</dt>
      <dd className="flex-1 text-gray-900">{children}</dd>
    </div>
  )
}
