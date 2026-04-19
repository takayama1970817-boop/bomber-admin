import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerOrders from '../hooks/useDealerOrders.js'
import DealerOrdersTable from '../components/DealerOrdersTable.jsx'
import DealerOrderDetailModal from '../components/DealerOrderDetailModal.jsx'

const STATUS_FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'processing', label: '処理中' },
  { value: 'shipped', label: '出荷済み' },
  { value: 'cancelled', label: 'キャンセル' },
]

/**
 * 代理店 注文一覧画面（Phase 1）
 *
 * 設計原則:
 *   - 日常オペレーション（確認・把握）用途。分析機能は入れない
 *   - データソースは Firestore のみ（BカートAPIは使わない）
 *   - Read-only。編集・更新機能なし
 *   - シンプル・高速・安全を優先
 */
export default function DealerOrders() {
  const { profile } = useAuth()
  const [filters, setFilters] = useState({ status: 'all' })
  const [selectedOrder, setSelectedOrder] = useState(null)

  const { orders, allOrders, loading, error } = useDealerOrders(profile, filters)

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">注文一覧</h1>
        <p className="mt-1 text-xs text-gray-500">
          自社配下サロンの注文を表示します（直近 50 件）
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
          {loading ? '—' : `${orders.length} / ${allOrders.length} 件`}
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
        <DealerOrdersTable orders={orders} onSelect={setSelectedOrder} />
      )}

      {/* 詳細モーダル */}
      <DealerOrderDetailModal
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  )
}
