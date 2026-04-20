import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerInvoices, { INVOICE_STATUS_LABELS } from '../hooks/useDealerInvoices.js'
import DealerInvoicesTable from '../components/DealerInvoicesTable.jsx'
import DealerInvoiceDetailModal from '../components/DealerInvoiceDetailModal.jsx'

const STATUS_FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'draft', label: INVOICE_STATUS_LABELS.draft },
  { value: 'sent', label: INVOICE_STATUS_LABELS.sent },
  { value: 'awaiting', label: INVOICE_STATUS_LABELS.awaiting },
  { value: 'paid', label: INVOICE_STATUS_LABELS.paid },
]

/**
 * 代理店 請求書一覧画面（Phase 2）
 *
 * 設計原則:
 *   - 日常オペレーション（確認・把握）用途
 *   - データソースは Firestore のみ（BカートAPIは使わない）
 *   - Read-only。編集・更新機能なし
 *   - シンプル・高速・安全を優先
 */
export default function DealerInvoices() {
  const { profile } = useAuth()
  const [filters, setFilters] = useState({ status: 'all' })
  const [selectedInvoice, setSelectedInvoice] = useState(null)

  const { invoices, allInvoices, loading, error } = useDealerInvoices(profile, filters)

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">請求書一覧</h1>
        <p className="mt-1 text-xs text-gray-500">
          自社宛の請求書を表示します（直近 50 件）
        </p>
      </div>

      {/* ステータスフィルタ */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <span className="text-xs text-gray-500">ステータス：</span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilters({ status: f.value })}
            className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${
              filters.status === f.value
                ? 'border-indigo-500 bg-indigo-500 text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto text-xs text-gray-500">
          {loading ? '—' : `${invoices.length} / ${allInvoices.length} 件`}
        </div>
      </div>

      {/* エラー */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ローディング */}
      {loading && !error && (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
          読み込み中...
        </div>
      )}

      {/* 一覧 */}
      {!loading && !error && (
        <DealerInvoicesTable invoices={invoices} onSelect={setSelectedInvoice} />
      )}

      {/* 詳細モーダル */}
      <DealerInvoiceDetailModal
        invoice={selectedInvoice}
        onClose={() => setSelectedInvoice(null)}
      />
    </div>
  )
}
