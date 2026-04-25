import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

/**
 * 代理店経営ダッシュボード 日時・天気カード
 *
 * 所在地の取得優先順位:
 *   1. allowedEmails.weatherLocation（明示指定・推奨）
 *   2. allowedEmails.address から「都道府県+市区町村」を抽出（郵便番号にも対応）
 *   3. 「東京都」フォールバック
 *
 * 天気API: Open-Meteo（無料・APIキー不要）
 *   geocoding: https://geocoding-api.open-meteo.com/v1/search
 *   forecast : https://api.open-meteo.com/v1/forecast
 *
 * 機能:
 *   - 日時表示（1分ごと、秒なし）
 *   - 今日 / 明日の天気アイコン・気温・降水確率
 *   - 雨アラート（明日の降水確率 80% 以上で表示）
 *   - スマホ: フルカード（md:hidden）
 *   - PC  : コンパクト1行ウィジェット（hidden md:block）
 */

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土']
const RAIN_ALERT_THRESHOLD = 80

function fmtNow(d) {
  const wk = WEEKDAY_JP[d.getDay()]
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}（${wk}）${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 住所から「都道府県+市区町村」を抽出
//   入力例: "544-0013 大阪府 大阪市生野区 巽中3-13-17" → "大阪府大阪市生野区"
//   先頭の郵便番号（NNN-NNNN または NNNNNNN）を除去してから抽出する
export function extractCityish(address) {
  if (!address) return null
  let s = String(address).normalize('NFKC').trim()
  // 先頭の郵便番号を除去（〒記号の有無、ハイフン有無に対応）
  s = s.replace(/^〒?\s*\d{3}[-－‐]?\d{4}\s*/, '')
  // 都道府県 + 市区町村
  const m = s.match(/^([^0-9\s]{2,4}[都道府県])\s*([^0-9\s]+?[市区町村郡])/)
  if (m) return m[1] + m[2]
  // 都道府県のみ
  const pref = s.match(/^([^0-9\s]{2,4}[都道府県])/)
  return pref?.[1] || null
}

// WMO 天気コード → アイコン+名称
const WMO = {
  0: { icon: '☀️', name: '晴れ' },
  1: { icon: '🌤️', name: 'おおむね晴れ' },
  2: { icon: '⛅', name: '晴れ時々くもり' },
  3: { icon: '☁️', name: 'くもり' },
  45: { icon: '🌫️', name: '霧' },
  48: { icon: '🌫️', name: '霧' },
  51: { icon: '🌦️', name: '小雨' },
  53: { icon: '🌦️', name: '雨' },
  55: { icon: '🌧️', name: '強い雨' },
  61: { icon: '🌦️', name: '雨' },
  63: { icon: '🌧️', name: '雨' },
  65: { icon: '🌧️', name: '強い雨' },
  71: { icon: '🌨️', name: '雪' },
  73: { icon: '🌨️', name: '雪' },
  75: { icon: '❄️', name: '大雪' },
  80: { icon: '🌦️', name: 'にわか雨' },
  81: { icon: '🌧️', name: 'にわか雨' },
  82: { icon: '⛈️', name: '激しい雨' },
  95: { icon: '⛈️', name: '雷雨' },
  96: { icon: '⛈️', name: '雷雨と雹' },
  99: { icon: '⛈️', name: '雷雨と雹' },
}
const wmoOf = (c) => WMO[c] || { icon: '🌡️', name: '—' }

export default function DealerWeatherCard({ dealerCode }) {
  const [now, setNow] = useState(new Date())
  const [placeQuery, setPlaceQuery] = useState('東京都')
  const [weather, setWeather] = useState(null)
  const [error, setError] = useState(null)

  // 1分ごとに時刻のみ更新
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // 所在地取得（優先順位: weatherLocation → address 解析 → 東京都）
  useEffect(() => {
    if (!dealerCode) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'allowedEmails'), where('dealerCode', '==', dealerCode)),
        )
        // weatherLocation を持つ行を最優先
        const docWithWL = snap.docs.find((d) => (d.data().weatherLocation || '').trim())
        if (docWithWL) {
          const wl = docWithWL.data().weatherLocation.trim()
          if (!cancelled) setPlaceQuery(wl)
          return
        }
        // 次点: address 解析
        const docWithAddr = snap.docs.find((d) => (d.data().address || '').trim())
        if (docWithAddr) {
          const place = extractCityish(docWithAddr.data().address)
          if (!cancelled && place) setPlaceQuery(place)
        }
        // どちらも無ければ '東京都' のまま
      } catch (e) {
        // 失敗時は 東京都 のままフォールバック
      }
    })()
    return () => { cancelled = true }
  }, [dealerCode])

  // 天気取得（所在地変更時のみ）
  useEffect(() => {
    let cancelled = false
    setError(null)
    ;(async () => {
      try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(placeQuery)}&count=1&language=ja&country=JP`
        const geoRes = await fetch(geoUrl)
        if (!geoRes.ok) throw new Error('geocoding HTTP ' + geoRes.status)
        const geoData = await geoRes.json()
        const r = geoData.results?.[0]
        if (!r) throw new Error('地名解決に失敗')
        const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia/Tokyo&forecast_days=2`
        const fcRes = await fetch(fcUrl)
        if (!fcRes.ok) throw new Error('forecast HTTP ' + fcRes.status)
        const fc = await fcRes.json()
        if (cancelled) return
        setWeather({
          place: r.admin1 ? `${r.admin1}${r.name === r.admin1 ? '' : ' ' + r.name}` : r.name,
          today: {
            code: fc.daily.weather_code[0],
            max: fc.daily.temperature_2m_max[0],
            min: fc.daily.temperature_2m_min[0],
            precip: fc.daily.precipitation_probability_max?.[0] ?? null,
          },
          tomorrow: {
            code: fc.daily.weather_code[1],
            max: fc.daily.temperature_2m_max[1],
            min: fc.daily.temperature_2m_min[1],
            precip: fc.daily.precipitation_probability_max?.[1] ?? null,
          },
        })
      } catch (e) {
        if (!cancelled) setError(e?.message || '天気取得失敗')
      }
    })()
    return () => { cancelled = true }
  }, [placeQuery])

  const today = useMemo(() => weather?.today, [weather])
  const tomorrow = useMemo(() => weather?.tomorrow, [weather])
  const tomorrowPrecip = tomorrow?.precip
  const rainAlert = typeof tomorrowPrecip === 'number' && tomorrowPrecip >= RAIN_ALERT_THRESHOLD
  const placeLabel = weather?.place || placeQuery

  return (
    <>
      {/* スマホ用: やわらかいフルカード（md+ では非表示） */}
      <div className="md:hidden">
        <div className="rounded-2xl border border-rose-100 bg-gradient-to-br from-rose-50 via-white to-sky-50 p-4 shadow-sm">
          <div className="text-[11px] tracking-wide text-rose-400">今日の予定にそなえて</div>
          <div className="mt-1 text-lg font-bold text-gray-800">{fmtNow(now)}</div>
          <div className="mt-1 text-xs text-gray-500">{placeLabel}</div>

          {!weather && !error && (
            <div className="mt-3 text-xs text-gray-400">天気を取得中…</div>
          )}
          {error && (
            <div className="mt-3 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
              天気情報を取得できませんでした
            </div>
          )}

          {weather && today && tomorrow && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-white/80 px-3 py-3 shadow-inner">
                  <div className="text-[11px] text-gray-500">今日</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-3xl leading-none">{wmoOf(today.code).icon}</span>
                    <span className="text-sm font-bold text-gray-800">{wmoOf(today.code).name}</span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-gray-600">
                    最高 <span className="font-bold text-rose-500">{Math.round(today.max)}℃</span>
                    　/ 最低 <span className="font-bold text-sky-500">{Math.round(today.min)}℃</span>
                  </div>
                </div>
                <div className="rounded-xl bg-white/80 px-3 py-3 shadow-inner">
                  <div className="text-[11px] text-gray-500">明日</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-3xl leading-none">{wmoOf(tomorrow.code).icon}</span>
                    <span className="text-sm font-bold text-gray-800">{wmoOf(tomorrow.code).name}</span>
                  </div>
                  <div className="mt-1.5 text-[11px] text-gray-600">
                    最高 <span className="font-bold text-rose-500">{Math.round(tomorrow.max)}℃</span>
                    　/ 最低 <span className="font-bold text-sky-500">{Math.round(tomorrow.min)}℃</span>
                  </div>
                  {tomorrowPrecip != null && (
                    <div className="mt-1 text-[11px] text-sky-600">降水 {tomorrowPrecip}%</div>
                  )}
                </div>
              </div>

              {rainAlert && (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/70 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="text-xl leading-none">☂</span>
                    <div className="text-[12px] leading-snug text-rose-700">
                      <div className="font-bold">明日の降水確率 {tomorrowPrecip}%</div>
                      <div className="mt-0.5 text-rose-600">
                        明日は雨の可能性が高いです。<br />
                        ご来店・配送の確認にご注意ください。
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* PC 用: コンパクト 1 行ウィジェット（mobile では非表示） */}
      <div className="hidden md:block">
        <div className="rounded-xl border border-rose-100 bg-gradient-to-r from-rose-50 via-white to-sky-50 px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
            <div className="text-gray-700">
              <span className="font-medium">{fmtNow(now)}</span>
              <span className="ml-2 text-gray-400">{placeLabel}</span>
            </div>

            {!weather && !error && (
              <div className="text-gray-400">天気を取得中…</div>
            )}
            {error && (
              <div className="rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                天気を取得できませんでした
              </div>
            )}

            {weather && today && tomorrow && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">今日</span>
                  <span className="text-base">{wmoOf(today.code).icon}</span>
                  <span className="text-gray-800">{wmoOf(today.code).name}</span>
                  <span className="text-gray-600">
                    <span className="font-bold text-rose-500">{Math.round(today.max)}℃</span>
                    /
                    <span className="font-bold text-sky-500">{Math.round(today.min)}℃</span>
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-gray-500">明日</span>
                  <span className="text-base">{wmoOf(tomorrow.code).icon}</span>
                  <span className="text-gray-800">{wmoOf(tomorrow.code).name}</span>
                  <span className="text-gray-600">
                    <span className="font-bold text-rose-500">{Math.round(tomorrow.max)}℃</span>
                    /
                    <span className="font-bold text-sky-500">{Math.round(tomorrow.min)}℃</span>
                  </span>
                  {tomorrowPrecip != null && (
                    <span className="ml-1 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
                      降水 {tomorrowPrecip}%
                    </span>
                  )}
                </div>

                {rainAlert && (
                  <div className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[11px] font-medium text-rose-700">
                    ☂ 明日は雨に注意
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
