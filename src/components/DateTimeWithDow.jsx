import { DOW_SHORT, getDowColorClass, getHolidayName } from '../lib/jpHolidays.js'

const pad = (n) => String(n).padStart(2, '0')

/**
 * YYYY/MM/DD（曜）HH:mm 表示。
 *   - 土曜: 青
 *   - 日曜 / 祝日: 赤
 *   - 祝日は title 属性で名称を出す
 */
export default function DateTimeWithDow({ value, showTime = true }) {
  if (!value) return <span>—</span>
  const d = typeof value.toDate === 'function' ? value.toDate() : new Date(value)
  if (Number.isNaN(d.getTime())) return <span>—</span>

  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const dow = DOW_SHORT[d.getDay()]
  const color = getDowColorClass(d)
  const holidayName = getHolidayName(d)

  return (
    <span className="whitespace-nowrap tabular-nums">
      {y}/{mo}/{dd}
      <span
        className={`mx-1.5 font-semibold ${color}`}
        title={holidayName ? `${dow}・${holidayName}` : undefined}
      >
        （{dow}）
      </span>
      {showTime && (
        <>
          {hh}:{mi}
        </>
      )}
    </span>
  )
}
