/**
 * 共通「再読込」ボタン
 *
 * 各画面で再読込のラベル/disable 状態がバラバラだったため統一。
 */
export default function RefreshButton({
  onClick,
  loading = false,
  disabled = false,
  label = '再読込',
  loadingLabel = '更新中…',
  icon = '🔄',
  title,
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      title={title}
      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {loading ? `⏳ ${loadingLabel}` : `${icon} ${label}`}
    </button>
  )
}
