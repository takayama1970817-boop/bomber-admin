/**
 * 日本の祝日をアルゴリズムで自動計算するヘルパー。
 *
 * 毎年手動で更新する必要は無い。
 *
 * カバー範囲:
 *   - 国民の祝日（固定日・ハッピーマンデー・春分/秋分）
 *   - 振替休日（日曜に祝日が重なったとき、次の平日を振替にする。GW のような
 *     連続祝日を跨ぐケースも対応）
 *   - 国民の休日（祝日に挟まれた平日）
 *
 * 春分/秋分の計算:
 *   国立天文台 暦要項に基づく小倉氏の近似式（西暦 1900-2099 の範囲で有効）。
 *     春分 = floor(20.8431 + 0.242194 × (Y-1980)) - floor((Y-1980)/4)
 *     秋分 = floor(23.2488 + 0.242194 × (Y-1980)) - floor((Y-1980)/4)
 *
 * 注意:
 *   - 東京五輪 (2020/2021) や即位の礼等の特別措置は未対応（運用対象外）。
 *   - 本アプリの主用途は 2020 年以降の運用なので、天皇誕生日は 2/23 固定扱い。
 */

export const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土']

// ----- 日付ユーティリティ -----
function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function nthWeekday(year, month0, weekday, n) {
  // month0: 0-indexed month
  // weekday: 0=Sun ... 6=Sat
  // n-th occurrence of weekday in the month (1..5)
  const first = new Date(year, month0, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  return 1 + offset + (n - 1) * 7
}

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4)
}

function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980)) - Math.floor((year - 1980) / 4)
}

// ----- 基本祝日（振替・国民の休日を除く） -----
function getBasicHolidayName(date) {
  const y = date.getFullYear()
  const m = date.getMonth()
  const d = date.getDate()

  // 固定日
  if (m === 0 && d === 1) return '元日'
  if (m === 1 && d === 11) return '建国記念の日'
  if (m === 1 && d === 23) return '天皇誕生日' // 2020〜
  if (m === 3 && d === 29) return '昭和の日'
  if (m === 4 && d === 3) return '憲法記念日'
  if (m === 4 && d === 4) return 'みどりの日'
  if (m === 4 && d === 5) return 'こどもの日'
  if (m === 7 && d === 11) return '山の日' // 2016〜
  if (m === 10 && d === 3) return '文化の日'
  if (m === 10 && d === 23) return '勤労感謝の日'

  // ハッピーマンデー
  if (m === 0 && d === nthWeekday(y, 0, 1, 2)) return '成人の日'
  if (m === 6 && d === nthWeekday(y, 6, 1, 3)) return '海の日'
  if (m === 8 && d === nthWeekday(y, 8, 1, 3)) return '敬老の日'
  if (m === 9 && d === nthWeekday(y, 9, 1, 2)) return 'スポーツの日'

  // 春分・秋分
  if (m === 2 && d === vernalEquinoxDay(y)) return '春分の日'
  if (m === 8 && d === autumnalEquinoxDay(y)) return '秋分の日'

  return null
}

// ----- 国民の休日 + 振替休日を含む祝日判定 -----
export function getHolidayName(date) {
  if (!date) return null
  const basic = getBasicHolidayName(date)
  if (basic) return basic

  const dow = date.getDay()
  if (dow === 0) return null // 日曜はそもそも祝日扱いしない（色分けは日曜色で出る）

  // 国民の休日: 平日で、前日・翌日がともに基本祝日
  const prev = addDays(date, -1)
  const next = addDays(date, 1)
  if (getBasicHolidayName(prev) && getBasicHolidayName(next)) return '国民の休日'

  // 振替休日: 過去の連続祝日を遡り、辿り着いた先が「日曜の祝日」であれば振替
  //   例) 5/6(水) ← 5/5(火 こどもの日) ← 5/4(月 みどりの日) ← 5/3(日 憲法記念日) → 振替
  let cursor = prev
  while (getBasicHolidayName(cursor)) {
    if (cursor.getDay() === 0) return '振替休日'
    cursor = addDays(cursor, -1)
  }

  return null
}

/**
 * 曜日ラベルの色クラス。
 *   日曜 or 祝日 → 赤（#D35A5A）
 *   土曜         → 青（#3B82C4）
 *   それ以外     → グレー
 */
export function getDowColorClass(date) {
  if (!date) return ''
  if (getHolidayName(date) || date.getDay() === 0) return 'text-[#D35A5A]'
  if (date.getDay() === 6) return 'text-[#3B82C4]'
  return 'text-gray-500'
}
