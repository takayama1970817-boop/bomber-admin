import { INVOICE_STATUS_LABELS, INVOICE_STATUS_BADGE } from '../hooks/useDealerInvoices.js'

const fmtYen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString()}`

function fmtMonth(m) {
  if (!m) return '—'
  return String(m).replace('-', '/')
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 請求書詳細モーダル。Read-only。
 * 表示: 対象月 / 金額サマリ / 対象注文一覧
 */
export default function DealerInvoiceDetailModal({ invoice, onClose }) {
  if (!invoice) return null

  const orders = Array.isArray(invoice.orders) ? invoice.orders : []
  const status = invoice.status || 'draft'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs text-gray-500">請求書詳細</div>
            <div className="mt-0.5 text-lg font-bold text-gray-900">
              {fmtMonth(invoice.month)} 分
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs">
              <span className={`rounded px-2 py-0.5 font-medium ${INVOICE_STATUS_BADGE[status] || INVOICE_STATUS_BADGE.draft}`}>
                {INVOICE_STATUS_LABELS[status] || status}
              </span>
              <span className="text-gray-500">作成: {fmtDate(invoice.createdAt)}</span>
            </div>
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

        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-[11px] text-gray-500">件数</div>
            <div className="mt-0.5 text-sm font-bold text-gray-900">
              {(invoice.orderCount ?? 0).toLocaleString()} 件
            </div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-[11px] text-gray-500">税抜</div>
            <div className="mt-0.5 text-sm font-bold text-gray-900">
              {fmtYen(invoice.subtotal)}
            </div>
          </div>
          <div className="rounded-lg bg-indigo-50 px-3 py-2">
            <div className="text-[11px] text-indigo-700">請求額（税込）</div>
            <div className="mt-0.5 text-base font-bold text-indigo-900">
              {fmtYen(invoice.grandTotal)}
            </div>
          </div>
        </div>

        <div className="mb-2 text-xs font-bold text-gray-700">対象注文（{orders.length}件）</div>
        {orders.length === 0 ? (
          <div className="rounded-lg bg-gray-50 px-4 py-6 text-center text-xs text-gray-400">
            注文情報がありません
          </div>
        ) : (
          <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left">注文番号</th>
                  <th className="px-3 py-2 text-left">サロン</th>
                  <th className="px-3 py-2 text-right">金額</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-mono text-xs text-gray-700">
                      {o.orderNumber || o.bcartOrderNumber || '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-900">
                      {o.companyName || '（不明）'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">
                      {fmtYen(o.total ?? o.grandTotal)}
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
