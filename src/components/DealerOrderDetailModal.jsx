const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 注文詳細モーダル。Read-only。
 * 表示: サロン名 / 合計金額 / 商品一覧（productName × qty）
 */
export default function DealerOrderDetailModal({ order, onClose }) {
  if (!order) return null

  const items = Array.isArray(order.items) ? order.items : []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs text-gray-500">注文詳細</div>
            <div className="mt-0.5 text-lg font-bold text-gray-900">
              {order.companyName || '（不明）'}
            </div>
            <div className="mt-0.5 text-xs text-gray-500">{fmtDate(order.orderDate)}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="閉じる"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mb-4 rounded-lg bg-indigo-50 px-4 py-3">
          <div className="text-xs text-indigo-700">合計金額（税込）</div>
          <div className="mt-0.5 text-2xl font-bold text-indigo-900">{fmtYen(order.total)}</div>
        </div>

        <div className="mb-2 text-xs font-bold text-gray-700">商品一覧（{items.length}点）</div>
        {items.length === 0 ? (
          <div className="rounded-lg bg-gray-50 px-4 py-6 text-center text-xs text-gray-400">
            商品情報がありません
          </div>
        ) : (
          <div className="max-h-72 overflow-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left">商品名</th>
                  <th className="px-3 py-2 text-right">数量</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-900">
                      {it.name || it.productName || '（不明）'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">
                      {Number(it.qty) || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
