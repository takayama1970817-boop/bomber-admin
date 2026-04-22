import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { isSalonAdmin, isSalonStaff } from '../lib/permissions.js'

function fmtYen(n) {
  if (n == null) return '¥0'
  return '¥' + Number(n).toLocaleString()
}

// 期間プリセット定義。カスタムは state.customStart / customEnd を使う。
const PERIOD_PRESETS = [
  { key: 'thisMonth', label: '今月' },
  { key: 'lastMonth', label: '先月' },
  { key: 'last30', label: '過去30日' },
  { key: 'custom', label: 'カスタム' },
]

// 指定プリセットに応じて [start, end) の Date を返す。
// end は「その日の翌日 0:00」として扱う（比較を < end で統一するため）。
function computeRange(preset, customStart, customEnd) {
  const now = new Date()
  if (preset === 'thisMonth') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1)
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return { start: s, end: e }
  }
  if (preset === 'lastMonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const e = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: s, end: e }
  }
  if (preset === 'last30') {
    const e = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const s = new Date(e)
    s.setDate(s.getDate() - 30)
    return { start: s, end: e }
  }
  if (preset === 'custom') {
    if (!customStart || !customEnd) return null
    const s = new Date(customStart)
    const eRaw = new Date(customEnd)
    if (isNaN(s.getTime()) || isNaN(eRaw.getTime())) return null
    // 終了日は「その日終了まで含む」ので +1 日する
    const e = new Date(eRaw.getFullYear(), eRaw.getMonth(), eRaw.getDate() + 1)
    return { start: s, end: e }
  }
  return null
}

export default function SalonSalesDetail() {
  const { profile } = useAuth()
  const companyName = profile?.companyName || ''
  const allowed = isSalonAdmin(profile) || isSalonStaff(profile)

  const [visits, setVisits] = useState([])
  const [loading, setLoading] = useState(true)

  const [preset, setPreset] = useState('thisMonth')
  // カスタム期間は「入力中」と「適用済み」を分けて保持する。
  // 入力中の値で即座に集計が変わると誤操作につながるため、「適用」押下時に applied に反映する。
  const [customStartInput, setCustomStartInput] = useState('')
  const [customEndInput, setCustomEndInput] = useState('')
  const [appliedCustomStart, setAppliedCustomStart] = useState('')
  const [appliedCustomEnd, setAppliedCustomEnd] = useState('')
  const [customError, setCustomError] = useState('')

  // データ取得は画面初期化時の1回のみ。期間切替では再取得せず、集計 useMemo を切り替える。
  useEffect(() => {
    if (!companyName || !allowed) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const cs = await getDocs(
          query(collection(db, 'customers'), where('salonCompanyName', '==', companyName)),
        )
        const all = []
        for (const c of cs.docs) {
          try {
            const vs = await getDocs(collection(db, 'customers', c.id, 'visits'))
            vs.docs.forEach((v) => all.push({ id: v.id, customerId: c.id, ...v.data() }))
          } catch (_) { /* 1顧客ぶんの失敗は全体を止めない */ }
        }
        if (!cancelled) setVisits(all)
      } catch (e) {
        console.error('売上詳細データ取得エラー:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [companyName, allowed])

  const range = useMemo(() => {
    return computeRange(preset, appliedCustomStart, appliedCustomEnd)
  }, [preset, appliedCustomStart, appliedCustomEnd])

  const inRangeVisits = useMemo(() => {
    if (!range) return []
    return visits.filter((v) => {
      const d = v.visitDate?.toDate ? v.visitDate.toDate() : null
      return d && d >= range.start && d < range.end
    })
  }, [visits, range])

  // === サマリー集計 ===
  // 期間合計売上は totalAmount 優先で統一（指示5）。
  const summary = useMemo(() => {
    const totalSales = inRangeVisits.reduce(
      (s, v) => s + (Number(v.totalAmount) || 0), 0,
    )
    const visitCount = inRangeVisits.length
    const avg = visitCount > 0 ? Math.round(totalSales / visitCount) : 0
    const productSales = inRangeVisits.reduce((s, v) => {
      return s + (v.productsSold || []).reduce(
        (ss, p) => ss + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0,
      )
    }, 0)
    const productRatio = totalSales > 0 ? Math.round((productSales / totalSales) * 100) : 0
    return { totalSales, visitCount, avg, productSales, productRatio }
  }, [inRangeVisits])

  // === メニュー別集計（参考値）===
  // 1来店に複数メニューがある場合、menuPrice はメニュー単位ではなく来店単位の値のため
  // 正確なメニュー別売上にはならない。画面には明示的に「参考値」と注記する。
  const menuBreakdown = useMemo(() => {
    const map = new Map()
    inRangeVisits.forEach((v) => {
      const menus = Array.isArray(v.menu) ? v.menu : []
      const price = Number(v.menuPrice) || 0
      if (menus.length === 0) return
      menus.forEach((m) => {
        const key = (m || '').trim()
        if (!key) return
        const cur = map.get(key) || { name: key, count: 0, total: 0 }
        cur.count += 1
        // 複数メニュー来店では menuPrice を均等割せず、各メニューに全額計上する「参考値」方式。
        // 均等割にすると合計が合わなくなり、全額計上にすると合計が膨らむ。
        // 今回は「提供回数×来店平均価格」のイメージで運用に寄せる判断。
        cur.total += price / menus.length
        map.set(key, cur)
      })
    })
    const totalMenuSales = Array.from(map.values()).reduce((s, x) => s + x.total, 0)
    return Array.from(map.values())
      .map((x) => ({
        ...x,
        total: Math.round(x.total),
        ratio: totalMenuSales > 0 ? Math.round((x.total / totalMenuSales) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total)
  }, [inRangeVisits])

  // === 商品別集計 ===
  const productBreakdown = useMemo(() => {
    const map = new Map()
    inRangeVisits.forEach((v) => {
      ;(v.productsSold || []).forEach((p) => {
        const key = p.productId || p.productName || ''
        if (!key) return
        const name = p.productName || key
        const qty = Number(p.quantity) || 0
        const price = Number(p.price) || 0
        const cur = map.get(key) || { productId: key, name, qty: 0, total: 0 }
        cur.qty += qty
        cur.total += qty * price
        map.set(key, cur)
      })
    })
    const totalProductSales = Array.from(map.values()).reduce((s, x) => s + x.total, 0)
    return Array.from(map.values())
      .map((x) => ({
        ...x,
        ratio: totalProductSales > 0 ? Math.round((x.total / totalProductSales) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total)
  }, [inRangeVisits])

  const handleApplyCustom = () => {
    if (!customStartInput || !customEndInput) {
      setCustomError('開始日と終了日を入力してください')
      return
    }
    const s = new Date(customStartInput)
    const e = new Date(customEndInput)
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      setCustomError('日付が正しくありません')
      return
    }
    if (s > e) {
      setCustomError('開始日は終了日より前にしてください')
      return
    }
    setCustomError('')
    setAppliedCustomStart(customStartInput)
    setAppliedCustomEnd(customEndInput)
  }

  if (!allowed) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">
        この画面を閲覧する権限がありません。
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">売上詳細</h1>
        <p className="mt-1 text-sm text-gray-500">
          自サロンの来店売上をメニュー・商品別に確認できます
        </p>
      </div>

      {/* 期間フィルタ */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`rounded-lg px-3 py-2 text-xs font-medium ${
                preset === p.key
                  ? 'bg-pink-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div>
              <label className="text-xs font-medium text-gray-700">開始日</label>
              <input
                type="date"
                value={customStartInput}
                onChange={(e) => setCustomStartInput(e.target.value)}
                className="mt-1 block rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">終了日</label>
              <input
                type="date"
                value={customEndInput}
                onChange={(e) => setCustomEndInput(e.target.value)}
                className="mt-1 block rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={handleApplyCustom}
              className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white hover:bg-pink-700"
            >
              適用
            </button>
            {customError && (
              <div className="text-xs text-red-600">{customError}</div>
            )}
          </div>
        )}

        {preset === 'custom' && !appliedCustomStart && !customError && (
          <div className="mt-2 text-xs text-gray-500">
            開始日・終了日を入力して「適用」を押すと集計されます。
          </div>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-500">
          読み込み中…
        </div>
      ) : !range ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
          期間を指定してください。
        </div>
      ) : (
        <>
          {/* サマリーカード */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-pink-200 bg-pink-50 p-4">
              <div className="text-xs text-pink-700">期間合計売上</div>
              <div className="mt-1 text-xl font-bold text-pink-700">{fmtYen(summary.totalSales)}</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">来店回数</div>
              <div className="mt-1 text-xl font-bold text-gray-900">{summary.visitCount}回</div>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">客単価</div>
              <div className="mt-1 text-xl font-bold text-gray-900">{fmtYen(summary.avg)}</div>
            </div>
            <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
              <div className="text-xs text-yellow-700">店販比率</div>
              <div className="mt-1 text-xl font-bold text-yellow-700">{summary.productRatio}%</div>
              <div className="text-[10px] text-yellow-600">店販売上 {fmtYen(summary.productSales)}</div>
            </div>
          </div>

          {inRangeVisits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
              この期間の来店記録はありません。
            </div>
          ) : (
            <>
              {/* メニュー別売上 */}
              <div className="rounded-xl border border-gray-200 bg-white">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                  <h2 className="text-sm font-bold text-gray-900">メニュー別売上</h2>
                  <span className="text-[10px] text-gray-500">
                    ※ 1来店に複数メニューがある場合の按分のため、参考値です
                  </span>
                </div>
                {menuBreakdown.length === 0 ? (
                  <div className="p-6 text-center text-xs text-gray-500">
                    メニュー記録がありません。
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                        <tr>
                          <th className="px-4 py-3 text-left">メニュー</th>
                          <th className="px-4 py-3 text-right">提供回数</th>
                          <th className="px-4 py-3 text-right">売上合計</th>
                          <th className="px-4 py-3 text-right">割合</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {menuBreakdown.map((m) => (
                          <tr key={m.name}>
                            <td className="px-4 py-3 text-gray-900">{m.name}</td>
                            <td className="px-4 py-3 text-right">{m.count}回</td>
                            <td className="px-4 py-3 text-right">{fmtYen(m.total)}</td>
                            <td className="px-4 py-3 text-right text-gray-500">{m.ratio}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* 商品別売上 */}
              <div className="rounded-xl border border-gray-200 bg-white">
                <div className="border-b border-gray-100 px-4 py-3">
                  <h2 className="text-sm font-bold text-gray-900">商品別売上</h2>
                </div>
                {productBreakdown.length === 0 ? (
                  <div className="p-6 text-center text-xs text-gray-500">
                    この期間の店販記録はありません。
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                        <tr>
                          <th className="px-4 py-3 text-left">商品名</th>
                          <th className="px-4 py-3 text-right">販売個数</th>
                          <th className="px-4 py-3 text-right">売上合計</th>
                          <th className="px-4 py-3 text-right">割合</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {productBreakdown.map((p) => (
                          <tr key={p.productId}>
                            <td className="px-4 py-3 text-gray-900">{p.name}</td>
                            <td className="px-4 py-3 text-right">{p.qty}個</td>
                            <td className="px-4 py-3 text-right">{fmtYen(p.total)}</td>
                            <td className="px-4 py-3 text-right text-gray-500">{p.ratio}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
