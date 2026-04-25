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

// 主要地のフォールバック座標（geocoding が失敗した時の保険）
//   日本語の「愛知県名古屋市」のような形式は Open-Meteo geocoding で
//   ヒットしないケースがあるため、よく出る都道府県・主要都市は座標を持っておく。
//   表示名は呼び出し側の placeLabel をそのまま使う（このマップの name はデバッグ用）。
const FALLBACK_COORDS = {
  // 都道府県（県庁所在地座標）
  '北海道': { lat: 43.0642, lon: 141.3469 },
  '青森県': { lat: 40.8244, lon: 140.7400 },
  '岩手県': { lat: 39.7036, lon: 141.1527 },
  '宮城県': { lat: 38.2682, lon: 140.8694 },
  '秋田県': { lat: 39.7186, lon: 140.1024 },
  '山形県': { lat: 38.2404, lon: 140.3636 },
  '福島県': { lat: 37.7503, lon: 140.4677 },
  '茨城県': { lat: 36.3418, lon: 140.4468 },
  '栃木県': { lat: 36.5658, lon: 139.8836 },
  '群馬県': { lat: 36.3911, lon: 139.0608 },
  '埼玉県': { lat: 35.8569, lon: 139.6489 },
  '千葉県': { lat: 35.6051, lon: 140.1233 },
  '東京都': { lat: 35.6762, lon: 139.6503 },
  '神奈川県': { lat: 35.4478, lon: 139.6425 },
  '新潟県': { lat: 37.9023, lon: 139.0237 },
  '富山県': { lat: 36.6953, lon: 137.2113 },
  '石川県': { lat: 36.5947, lon: 136.6256 },
  '福井県': { lat: 36.0652, lon: 136.2216 },
  '山梨県': { lat: 35.6642, lon: 138.5683 },
  '長野県': { lat: 36.6513, lon: 138.1810 },
  '岐阜県': { lat: 35.3912, lon: 136.7223 },
  '静岡県': { lat: 34.9769, lon: 138.3831 },
  '愛知県': { lat: 35.1815, lon: 136.9066 },
  '三重県': { lat: 34.7303, lon: 136.5086 },
  '滋賀県': { lat: 35.0045, lon: 135.8686 },
  '京都府': { lat: 35.0116, lon: 135.7681 },
  '大阪府': { lat: 34.6937, lon: 135.5023 },
  '兵庫県': { lat: 34.6913, lon: 135.1830 },
  '奈良県': { lat: 34.6851, lon: 135.8048 },
  '和歌山県': { lat: 34.2261, lon: 135.1675 },
  '鳥取県': { lat: 35.5039, lon: 134.2381 },
  '島根県': { lat: 35.4723, lon: 133.0505 },
  '岡山県': { lat: 34.6618, lon: 133.9344 },
  '広島県': { lat: 34.3853, lon: 132.4553 },
  '山口県': { lat: 34.1859, lon: 131.4706 },
  '徳島県': { lat: 34.0658, lon: 134.5593 },
  '香川県': { lat: 34.3401, lon: 134.0434 },
  '愛媛県': { lat: 33.8416, lon: 132.7657 },
  '高知県': { lat: 33.5597, lon: 133.5311 },
  '福岡県': { lat: 33.5904, lon: 130.4017 },
  '佐賀県': { lat: 33.2494, lon: 130.2989 },
  '長崎県': { lat: 32.7503, lon: 129.8779 },
  '熊本県': { lat: 32.7898, lon: 130.7417 },
  '大分県': { lat: 33.2382, lon: 131.6126 },
  '宮崎県': { lat: 31.9111, lon: 131.4239 },
  '鹿児島県': { lat: 31.5602, lon: 130.5581 },
  '沖縄県': { lat: 26.2125, lon: 127.6809 },
  // 主要市区町村（よく当たるもの）
  '愛知県名古屋市': { lat: 35.1815, lon: 136.9066 },
  '大阪府大阪市': { lat: 34.6937, lon: 135.5023 },
  '東京都新宿区': { lat: 35.6938, lon: 139.7036 },
  '東京都渋谷区': { lat: 35.6580, lon: 139.7016 },
  '東京都世田谷区': { lat: 35.6464, lon: 139.6533 },
  '神奈川県横浜市': { lat: 35.4478, lon: 139.6425 },
  '京都府京都市': { lat: 35.0116, lon: 135.7681 },
  '兵庫県神戸市': { lat: 34.6913, lon: 135.1830 },
  '福岡県福岡市': { lat: 33.5904, lon: 130.4017 },
  '宮城県仙台市': { lat: 38.2682, lon: 140.8694 },
  '広島県広島市': { lat: 34.3853, lon: 132.4553 },
  '埼玉県さいたま市': { lat: 35.8617, lon: 139.6455 },
  '千葉県千葉市': { lat: 35.6051, lon: 140.1233 },
  '栃木県宇都宮市': { lat: 36.5551, lon: 139.8826 },
}

// 場所名からフォールバック座標を引く
function lookupFallbackCoords(place) {
  if (!place) return null
  const s = String(place).normalize('NFKC').replace(/\s+/g, '')
  if (FALLBACK_COORDS[s]) return FALLBACK_COORDS[s]
  // 都道府県＋市町村パターンで都道府県のみで再検索
  const m = s.match(/^([^0-9]{2,4}[都道府県])/)
  if (m && FALLBACK_COORDS[m[1]]) return FALLBACK_COORDS[m[1]]
  return null
}

// 段階的に geocoding を試行、失敗したらフォールバック座標、それも無ければ東京都
async function resolveCoords(placeQuery) {
  if (!placeQuery) return { lat: 35.6762, lon: 139.6503, source: 'default' }
  // 試行する name 候補
  const tries = [placeQuery]
  // 「愛知県名古屋市」→「愛知県 名古屋市」「名古屋市」「愛知県」を追加
  const m = String(placeQuery).normalize('NFKC').match(/^([^0-9\s]{2,4}[都道府県])\s*(.+)/)
  if (m) {
    tries.push(`${m[1]} ${m[2]}`)
    tries.push(m[2])
    tries.push(m[1])
  }
  for (const q of tries) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ja&country=JP`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = await res.json()
      const r = data.results?.[0]
      if (r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
        return { lat: r.latitude, lon: r.longitude, source: 'geocoding' }
      }
    } catch {
      // 続行
    }
  }
  // フォールバック座標
  const fb = lookupFallbackCoords(placeQuery)
  if (fb) return { lat: fb.lat, lon: fb.lon, source: 'fallback' }
  // 最終フォールバック: 東京都
  return { lat: 35.6762, lon: 139.6503, source: 'default-tokyo' }
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
  // キャッシュ戦略（PR 2026-04-25）:
  //   - localStorage: weatherCard:{dealerCode}:{placeQuery}:v1
  //   - 当日キャッシュがあれば fetch せず即時表示
  //   - 翌日になったら再取得
  //   - fetch 失敗時は古いキャッシュがあればそれを表示（停電耐性）
  // 1. resolveCoords: geocoding（複数パターン）→ フォールバック座標 → 東京都の順
  // 2. forecast: lat/lon で 2日分（weather_code / temp max/min / precip prob max）
  // 3. 表示地名は placeQuery を維持
  // 4. エラー時も place 表示は維持
  useEffect(() => {
    if (!placeQuery) return
    let cancelled = false
    setError(null)
    const cacheKey = `weatherCard:${dealerCode || 'anon'}:${placeQuery}:v1`
    const today = new Date().toISOString().slice(0, 10)

    // 同日キャッシュがあれば即時表示して fetch スキップ
    let staleCache = null
    try {
      const raw = localStorage.getItem(cacheKey)
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached?.weather) {
          if (cached.date === today) {
            setWeather(cached.weather)
            return // ← 当日 → fetch しない
          }
          // 当日でなくても、fetch 失敗時のフォールバックとして保持
          staleCache = cached.weather
        }
      }
    } catch (e) { /* ignore */ }

    ;(async () => {
      try {
        const coords = await resolveCoords(placeQuery)
        const fcUrl = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia/Tokyo&forecast_days=2`
        const fcRes = await fetch(fcUrl)
        if (!fcRes.ok) throw new Error('forecast HTTP ' + fcRes.status)
        const fc = await fcRes.json()
        if (cancelled) return
        if (!fc?.daily?.weather_code) throw new Error('forecast データ形式異常')
        const next = {
          place: placeQuery,
          source: coords.source,
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
        }
        setWeather(next)
        // 取得成功 → キャッシュ保存
        try {
          localStorage.setItem(cacheKey, JSON.stringify({
            date: today,
            fetchedAt: Date.now(),
            weather: next,
          }))
        } catch (e) { /* ignore */ }
      } catch (e) {
        console.warn('[DealerWeatherCard] 天気取得失敗:', e?.message, 'place=', placeQuery)
        if (!cancelled) {
          if (staleCache) {
            setWeather(staleCache) // 取得失敗でも前回成功データを表示継続
          } else {
            setError(e?.message || '天気取得失敗')
          }
        }
      }
    })()
    return () => { cancelled = true }
  }, [placeQuery, dealerCode])

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
              {placeLabel} の天気情報を取得できませんでした
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
                {placeLabel} の天気を取得できませんでした
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
