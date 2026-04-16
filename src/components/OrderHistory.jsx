import { Fragment, useEffect, useState } from 'react'
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import OrderForm from './OrderForm.jsx'

const fmtDate = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleDateString('ja-JP')
}

export default function OrderHistory({ salonId, currentLastOrderDate, onOrderAdded }) {
  const { isAdmin } = useAuth()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const q = query(
        collection(db, 'orders'),
        where('salonId', '==', salonId),
        orderBy('orderDate', 'desc'),
      )
      const snap = await getDocs(q)
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salonId])

  const onSaved = async () => {
    setShowForm(false)
    await load()
    onOrderAdded?.()
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">発注履歴</h2>
        {isAdmin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
          >
            + 発注を追加
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <OrderForm
            salonId={salonId}
            currentLastOrderDate={currentLastOrderDate}
            onSaved={onSaved}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-sm text-gray-400">
          読み込み中...
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-400">
          発注履歴はまだありません
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">発注日</th>
                <th className="px-3 py-2 text-right">合計</th>
                <th className="px-3 py-2">明細数</th>
                <th className="px-3 py-2">ソース</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const isOpen = expandedId === o.id
                return (
                  <Fragment key={o.id}>
                    <tr
                      className="cursor-pointer border-t border-gray-100 hover:bg-gray-50"
                      onClick={() => setExpandedId(isOpen ? null : o.id)}
                    >
                      <td className="px-3 py-2">{fmtDate(o.orderDate)}</td>
                      <td className="px-3 py-2 text-right font-medium">
                        ¥{(o.total ?? 0).toLocaleString('ja-JP')}
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {o.items?.length ?? 0}件
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${
                            o.source === 'bcart'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {o.source ?? 'manual'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {isOpen ? '▲' : '▼'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-3 py-3">
                          <div className="space-y-1">
                            {(o.items ?? []).map((it, i) => (
                              <div
                                key={i}
                                className="flex justify-between text-xs"
                              >
                                <span>{it.name}</span>
                                <span className="text-gray-500">
                                  {it.qty} × ¥{(it.price ?? 0).toLocaleString('ja-JP')} = ¥
                                  {((it.qty ?? 0) * (it.price ?? 0)).toLocaleString('ja-JP')}
                                </span>
                              </div>
                            ))}
                            {o.memo && (
                              <div className="mt-2 border-t border-gray-200 pt-2 text-xs text-gray-500">
                                📝 {o.memo}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
