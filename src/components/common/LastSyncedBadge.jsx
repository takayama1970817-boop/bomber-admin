/**
 * 共通「最終同期時刻」バッジ
 *
 * Bカート → Firestore など、データ鮮度を示す。
 * staleHours を超えると amber、それ以下は gray で表示。
 */
import { fmtDateTime } from '../../lib/formatters.js'

export default function LastSyncedBadge({
  syncedAt,
  staleHours = 24,
  label = 'Bカート 最終同期',
  emptyLabel = '同期記録なし',
}) {
  if (!syncedAt) {
    return (
      <p className="mb-1 text-[11px] text-gray-400">{label}: {emptyLabel}</p>
    )
  }
  const d = syncedAt instanceof Date ? syncedAt : new Date(syncedAt)
  if (isNaN(d.getTime())) {
    return (
      <p className="mb-1 text-[11px] text-gray-400">{label}: {emptyLabel}</p>
    )
  }
  const ageH = Math.floor((Date.now() - d.getTime()) / 3600000)
  const stale = ageH >= staleHours
  return (
    <p className={`mb-1 text-xs ${stale ? 'text-amber-700' : 'text-gray-400'}`}>
      {label}: {fmtDateTime(d)}（{ageH} 時間前）
      {stale && '。これ以降の更新は未反映の可能性があります。'}
    </p>
  )
}
