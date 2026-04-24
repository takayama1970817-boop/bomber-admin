import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerOrders from '../hooks/useDealerOrders.js'
import DealerOrdersTable from '../components/DealerOrdersTable.jsx'
import DealerOrderDetailModal from '../components/DealerOrderDetailModal.jsx'

/**
 * 代理店 注文一覧画面（Phase 1）
 *
 * 設計原則:
 *   - 日常オペレーション（確認・把握）用途。分析機能は入れない
 *   - データソースは Firestore のみ（BカートAPIは使わない）
 *   - Read-only。編集・更新機能なし
 *   - シンプル・高速・安全を優先
 *
 * ステータス管理は代理店側では行わない方針（2026-04-24 確定）。
 *   - 代理店側では注文ステータスを編集不可
 *   - ステータス列・フィルタは非表示（Bカート側で管理）
 *   - 「処理中」固定表示による誤解を防ぐため表示を撤去
 */
export default function DealerOrders() {
  const { profile } = useAuth()
  const [selectedOrder, setSelectedOrder] = useState(null)

  // ステータスフィルタは非表示方針のため 'all' 固定
  const { orders, allOrders, loading, error } = useDealerOrders(profile, { status: 'all' })

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">注文一覧</h1>
        <p className="mt-1 text-xs text-gray-500">
          自社配下サロンの注文を表示します（直近 50 件）
        </p>
      </div>

      {/* 件数サマリ（ステータスフィルタは非表示） */}
      <div className="flex items-center justify-end rounded-xl border border-gray-200 bg-white p-3">
        <div className="text-xs text-gray-500">
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
