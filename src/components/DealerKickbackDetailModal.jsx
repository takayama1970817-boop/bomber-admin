import {
  KICKBACK_STATUS_LABELS,
  KICKBACK_STATUS_BADGE,
  normalizeKickbackStatus,
  extractKickbackAmount,
  extractSalesAmount,
  extractRate,
  canDownloadKickbackPdf,
  openKickbackPdf,
} from '../hooks/useDealerKickbacks.js'

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

function fmtRate(r) {
  if (r == null) return '—'
  return `${(Number(r) * 100).toFixed(1)}%`
}

/**
 * kickback ドキュメントの entries / breakdown からサロン内訳を正規化。
 * entries の場合: { salonName, orderTotal, kickbackAmount }
 * breakdown の場合: { companyName, salesAmount, kickbackAmount }
 */
function extractBreakdown(kb) {
  if (Array.isArray(kb.breakdown) && kb.breakdown.length > 0) {
    return kb.breakdown.map((b) => ({
      name: b.companyName || b.salonName || '（不明）',
      sales: Number(b.salesAmount ?? b.orderTotal ?? 0) || 0,
      kick: Number(b.kickbackAmount ?? 0) || 0,
    }))
  }
  if (Array.isArray(kb.entries) && kb.entries.length > 0) {
    return kb.entries.map((e) => ({
      name: e.salonName || e.companyName || '（不明）',
      sales: Number(e.orderTotal ?? e.salesAmount ?? 0) || 0,
      kick: Number(e.kickbackAmount ?? 0) || 0,
    }))
  }
  return []
}

export default function DealerKickbackDetailModal({ kickback, onClose }) {
  if (!kickback) return null

  const status = normalizeKickbackStatus(kickback)
  const breakdown = extractBreakdown(kickback)
  const rate = extractRate(kickback)
  const salesAmount = extractSalesAmount(kickback)
  const kickAmount = extractKickbackAmount(kickback)

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
            <div className="text-xs text-gray-500">キックバック清算詳細</div>
            <div className="mt-0.5 text-lg font-bold text-gray-900">
              {fmtMonth(kickback.month || kickback.period)} 分
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs">
              <span className={`rounded px-2 py-0.5 font-medium ${KICKBACK_STATUS_BADGE[status]}`}>
                {KICKBACK_STATUS_LABELS[status]}
              </span>
              {kickback.scheduledAt && (
                <span className="text-gray-600">支払予定: {fmtDate(kickback.scheduledAt)}</span>
              )}
              {kickback.paidAt && (
                <span className="text-emerald-700">支払済: {fmtDate(kickback.paidAt)}</span>
              )}
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

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-[11px] text-gray-500">対象売上</div>
            <div className="mt-0.5 text-sm font-bold text-gray-900">{fmtYen(salesAmount)}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-[11px] text-gray-500">料率</div>
            <div className="mt-0.5 text-sm font-bold text-gray-900">{fmtRate(rate)}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-[11px] text-gray-500">対象サロン数</div>
            <div className="mt-0.5 text-sm font-bold text-gray-900">
              {breakdown.length > 0 ? `${breakdown.length} 店` : '—'}
            </div>
          </div>
          <div className="rounded-lg bg-indigo-50 px-3 py-2">
            <div className="text-[11px] text-indigo-700">キックバック額</div>
            <div className="mt-0.5 text-base font-bold text-indigo-900">{fmtYen(kickAmount)}</div>
          </div>
        </div>

        <div className="mb-2 text-xs font-bold text-gray-700">対象サロン内訳（{breakdown.length}店）</div>
        {breakdown.length === 0 ? (
          <div className="rounded-lg bg-gray-50 px-4 py-6 text-center text-xs text-gray-400">
            明細はありません
          </div>
        ) : (
          <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left">サロン</th>
                  <th className="px-3 py-2 text-right">売上</th>
                  <th className="px-3 py-2 text-right">キックバック</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-gray-900">{b.name}</td>
                    <td className="px-3 py-2 text-right text-gray-700">{fmtYen(b.sales)}</td>
                    <td className="px-3 py-2 text-right font-medium text-indigo-900">{fmtYen(b.kick)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          {canDownloadKickbackPdf(kickback) ? (
            <button
              onClick={() => openKickbackPdf(kickback.pdfUrl)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              📄 PDFダウンロード
            </button>
          ) : (
            <span />
          )}
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
