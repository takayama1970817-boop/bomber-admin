// 横展開 Phase 2（2026-04-25）: 表示フォーマッタ統一
import { fmtYen, fmtDate } from '../lib/formatters.js'

/**
 * dealer 注文一覧テーブル。操作は詳細ボタンのみ（編集・更新は一切なし）。
 * ステータス列は非表示（2026-04-24 方針確定）。
 *
 * 0 件時の表示は呼び出し元（DealerOrders.jsx）の EmptyStateCard に委譲。
 * このコンポーネントは orders が 1 件以上ある前提で描画する。
 */
export default function DealerOrdersTable({ orders, onSelect }) {
  if (!orders || orders.length === 0) return null

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
