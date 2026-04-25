/**
 * 共通ローディング表示
 *
 * 各画面の「読み込み中...」テキストを統一。
 * variant='text' でシンプル文字、'card' で複数枠スケルトン。
 */
export default function LoadingSkeleton({ variant = 'text', lines = 3, label = '読み込み中…' }) {
  if (variant === 'text') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-500">
        <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-emerald-400" />
        {label}
      </div>
    )
  }
  // card variant: 複数枠スケルトン
  return (
    <div className="space-y-3">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-gray-200 bg-white p-4"
        >
          <div className="mb-2 h-3 w-1/4 rounded bg-gray-200" />
          <div className="h-5 w-1/2 rounded bg-gray-200" />
        </div>
      ))}
    </div>
  )
}
