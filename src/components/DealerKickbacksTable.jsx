import {
  extractKickbackAmount,
  extractSalesAmount,
  canDownloadKickbackPdf,
  canDownloadKickbackCsv,
  openKickbackPdf,
  openKickbackCsv,
  deriveDisplayLabel,
  displayBadgeClass,
} from '../hooks/useDealerKickbacks.js'
// 横展開 Phase 3（2026-04-25）: 表示フォーマッタ統一
import { fmtYen, fmtDate } from '../lib/formatters.js'

function fmtMonth(m) {
  if (!m) return '—'
  return String(m).replace('-', '/')
}

/**
 * 0 件時の表示は呼び出し元（DealerKickbacks.jsx）の EmptyStateCard に委譲。
 * このコンポーネントは kickbacks が 1 件以上ある前提で描画する。
 */
export default function DealerKickbacksTable({ kickbacks, onSelect }) {
  if (!kickbacks || kickbacks.length === 0) return null

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-4 py-2 text-left">月</th>
            <th className="px-4 py-2 text-right">対象売上</th>
            <th className="px-4 py-2 text-right">キックバック</th>
            <th className="px-4 py-2 text-left">支払予定日</th>
            <th className="px-4 py-2 text-left">状態</th>
            <th className="px-4 py-2 text-center">PDF</th>
            <th className="px-4 py-2 text-center">CSV</th>
            <th className="px-4 py-2 text-center">詳細</th>
          </tr>
        </thead>
        <tbody>
          {kickbacks.map((kb) => (
              <tr key={kb.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 whitespace-nowrap font-medium text-gray-900">
                  {fmtMonth(kb.month || kb.period)}
                </td>
                <td className="px-4 py-2 text-right text-gray-700">
                  {fmtYen(extractSalesAmount(kb))}
                </td>
                <td className="px-4 py-2 text-right font-bold text-indigo-900">
                  {fmtYen(extractKickbackAmount(kb))}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {fmtDate(kb.scheduledAt) === '—' ? '—' : fmtDate(kb.scheduledAt)}
                </td>
                <td className="px-4 py-2">
                  {/* PR-B: 5 値ラベル（phase + mailStatus） */}
                  <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${displayBadgeClass(kb)}`}>
                    {deriveDisplayLabel(kb)}
                  </span>
                </td>
                <td className="px-4 py-2 text-center">
                  {canDownloadKickbackPdf(kb) ? (
                    <button
                      onClick={() => openKickbackPdf(kb.pdfUrl)}
                      className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      title="清算書PDFを開く（メール送信有無に関わらず取得可）"
                    >
                      📄 PDF
                    </button>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-center">
                  {canDownloadKickbackCsv(kb) ? (
                    <button
                      onClick={() => openKickbackCsv(kb.csvUrl)}
                      className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      title="明細CSVをダウンロード（メール送信有無に関わらず取得可）"
                    >
                      📊 CSV
                    </button>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-center">
                  <button
                    onClick={() => onSelect?.(kb)}
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
