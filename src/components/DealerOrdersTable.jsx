const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * dealer 注文一覧テーブル。操作は詳細ボタンのみ（編集・更新は一切なし）。
 * ステータス列は非表示（2026-04-24 方針確定）。
 */
export default function DealerOrdersTable({ orders, onSelect }) {
  if (!orders || orders.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
        注文がまだありません
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-4 py-2 text-left">日付</th>
            <th className="px-4 py-2 text-left">サロン</th>
            <th className="px-4 py-2 text-right">金額</th>
            <th className="px-4 py-2 text-center">詳細</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-t border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-2 whitespace-nowrap text-gray-700">
                {fmtDate(o.orderDate)}
              </td>
              <td className="px-4 py-2 text-gray-900">
                {o.companyName || '（不明）'}
              </td>
              <td className="px-4 py-2 text-right font-medium text-gray-900">
                {fmtYen(o.total)}
              </td>
              <td className="px-4 py-2 text-center">
                <button
                  onClick={() => onSelect?.(o)}
                  className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  詳細
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
