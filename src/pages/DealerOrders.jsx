import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import useDealerOrders from '../hooks/useDealerOrders.js'
import DealerOrdersTable from '../components/DealerOrdersTable.jsx'
import DealerOrderDetailModal from '../components/DealerOrderDetailModal.jsx'
// 横展開 Phase 2（2026-04-25）: 共通 UI 部品
import {
  LoadingSkeleton,
  ErrorBanner,
  RefreshButton,
  LastSyncedBadge,
  EmptyStateCard,
} from '../components/common/index.js'

/**
 * 代理店 注文一覧画面（Phase 1 → Phase 2 横展開対応）
 *
 * 設計原則:
 *   - 日常オペレーション（確認・把握）用途。分析機能は入れない
 *   - データソースは Firestore のみ（BカートAPIは使わない）
 *   - Read-only。編集・更新機能なし
 *   - シンプル・高速・安全を優先
 *
 * 横展開 Phase 2:
 *   - localStorage 当日キャッシュ（key: dealerOrders:{dealerCode}:v1）
 *   - 明示的 reload ボタン（キャッシュバイパス）
 *   - LastSyncedBadge / ErrorBanner / EmptyStateCard / LoadingSkeleton
 *   - 0 件取得で既存 orders を上書きしない（hook 側）
 */
export default function DealerOrders() {
  const { profile } = useAuth()
  const [selectedOrder, setSelectedOrder] = useState(null)

  // dealerCode 単位 cacheKey（他代理店データ混入防止）
  const cacheKey = profile?.dealerCode
    ? `dealerOrders:${profile.dealerCode}:v1`
    : null

  // ステータスフィルタは非表示方針のため 'all' 固定
  const { orders, allOrders, loading, error, reload } = useDealerOrders(
    profile,
    { status: 'all' },
    { cacheKey },
  )

  // orders.syncedAt の最大値から最終同期時刻を導出
  const lastSyncedAt = useMemo(() => {
    let latest = null
    for (const o of allOrders) {
      const sec = o.syncedAt?._seconds ?? o.syncedAt?.seconds
      const d = sec ? new Date(sec * 1000)
        : o.syncedAt instanceof Date ? o.syncedAt
        : null
      if (d && (!latest || d > latest)) latest = d
    }
    return latest
  }, [allOrders])

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">注文一覧</h1>
          <p className="mt-1 text-xs text-gray-500">
            自社配下サロンの注文を表示します（直近 50 件）
          </p>
        </div>
        <RefreshButton
          onClick={reload}
          loading={loading}
          label="再読込"
          title="Firestore から最新の注文を再取得（当日キャッシュをバイパス）"
        />
      </div>

      {/* データ鮮度バッジ */}
      <LastSyncedBadge syncedAt={lastSyncedAt} />

      {/* 件数サマリ（ステータスフィルタは非表示） */}
      <div className="flex items-center justify-end rounded-xl border border-gray-200 bg-white p-3">
        <div className="text-xs text-gray-500">
          {loading ? '—' : `${orders.length} / ${allOrders.length} 件`}
        </div>
      </div>

      {/* エラー */}
      <ErrorBanner message={error} onRetry={reload} />

      {/* ローディング */}
      {loading && !error && <LoadingSkeleton variant="card" lines={3} />}

      {/* 一覧 / 0件 */}
      {!loading && !error && (
        orders.length === 0 ? (
          <EmptyStateCard
            icon="📦"
            title="注文がまだありません"
            description="Bカート 同期後に表示されます。最新データを反映するには右上の「🔄 再読込」を押してください。"
          />
        ) : (
          <DealerOrdersTable orders={orders} onSelect={setSelectedOrder} />
        )
      )}

      {/* 詳細モーダル */}
      <DealerOrderDetailModal
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />
    </div>
  )
}
