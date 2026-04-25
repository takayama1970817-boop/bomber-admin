/**
 * 共通「0件時の空表示」カード
 *
 * 各画面で個別に書かれていた「データがありません」系を統一。
 */
export default function EmptyStateCard({
  icon = '📭',
  title = 'データがありません',
  description = '',
  action = null,
}) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
      <div className="mb-2 text-3xl">{icon}</div>
      <div className="text-sm font-medium text-gray-700">{title}</div>
      {description && (
        <div className="mt-1 text-xs text-gray-500">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
