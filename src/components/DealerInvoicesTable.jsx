import { INVOICE_STATUS_LABELS, INVOICE_STATUS_BADGE } from '../hooks/useDealerInvoices.js'

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

function fmtMonth(m) {
  if (!m) return '—'
  // "2026-04" 形式をそのまま "2026/04" で返す
  return String(m).replace('-', '/')
}

export default function DealerInvoicesTable({ invoices, onSelect }) {
  if (!invoices || invoices.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
        請求書がまだありません
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-4 py-2 text-left">対象月</th>
            <th className="px-4 py-2 text-right">件数</th>
            <th className="px-4 py-2 text-right">請求額（税込）</th>
            <th className="px-4 py-2 text-left">ステータス</th>
            <th className="px-4 py-2 text-center">詳細</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const status = inv.status || 'draft'
            return (
              <tr key={inv.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 whitespace-nowrap text-gray-900 font-medium">
                  {fmtMonth(inv.month)}
                </td>
                <td className="px-4 py-2 text-right text-gray-700">
                  {(inv.orderCount ?? 0).toLocaleString()} 件
                </td>
                <td className="px-4 py-2 text-right font-medium text-gray-900">
                  {fmtYen(inv.grandTotal)}
                </td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${INVOICE_STATUS_BADGE[status] || INVOICE_STATUS_BADGE.draft}`}>
                    {INVOICE_STATUS_LABELS[status] || status}
                  </span>
                </td>
                <td className="px-4 py-2 text-center">
                  <button
                    onClick={() => onSelect?.(inv)}
                    className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                  >
                    詳細
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
