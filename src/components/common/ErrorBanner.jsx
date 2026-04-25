/**
 * 共通エラー表示バナー
 *
 * 赤背景の統一エラーバナー。onRetry 渡すと「再試行」ボタンを出す。
 */
export default function ErrorBanner({ message, onRetry, retryLabel = '再試行' }) {
  if (!message) return null
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      <span className="flex-1">⚠ {message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded border border-red-300 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100"
        >
          {retryLabel}
        </button>
      )}
    </div>
  )
}
