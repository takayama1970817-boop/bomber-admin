import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { fetchOrdersSince, fetchAllOrderProducts, fetchAllCustomers } from '../lib/bcartApi.js'
import { filterValidOrders } from '../lib/ordersFilter.js'
import { normalizeCompanyName, pickDisplayName } from '../lib/nameNormalize.js'

const fmtYen = (n) => `¥${Number(n || 0).toLocaleString('ja-JP')}`
const fmtDate = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleDateString('ja-JP')
}
const fmtDateTime = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleString('ja-JP')
}

// 今日の日付（YYYY-MM-DD）
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県',
  '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県',
  '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
]

// N日前
const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function SalonSales() {
  const { isAdmin, hasAccess, profile, isSalon, isDealer } = useAuth()
  const [orders, setOrders] = useState([])
  const [salons, setSalons] = useState([])
  const [bcartCustomers, setBcartCustomers] = useState([]) // Bカート会員一覧
  const [loadingCustomers, setLoadingCustomers] = useState(false)
  const [loading, setLoading] = useState(true)

  // 検索条件
  const [salonKeyword, setSalonKeyword] = useState('')
  const [selectedSalon, setSelectedSalon] = useState('') // companyName
  const [dateFrom, setDateFrom] = useState(daysAgo(30))
  const [dateTo, setDateTo] = useState(today())
  const [onlyWithSales, setOnlyWithSales] = useState(false) // 売上ありのみ表示

  // 詳細検索条件
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [filterRepLast, setFilterRepLast] = useState('')
  const [filterRepFirst, setFilterRepFirst] = useState('')
  const [filterRepLastKana, setFilterRepLastKana] = useState('')
  const [filterRepFirstKana, setFilterRepFirstKana] = useState('')
  const [filterTantoLast, setFilterTantoLast] = useState('')
  const [filterTantoFirst, setFilterTantoFirst] = useState('')
  const [filterTantoLastKana, setFilterTantoLastKana] = useState('')
  const [filterTantoFirstKana, setFilterTantoFirstKana] = useState('')
  const [filterPref, setFilterPref] = useState('')
  const [filterEmail, setFilterEmail] = useState('')

  // Bカート直接集計（検索ボタンで実行）
  const [liveOrders, setLiveOrders] = useState([])
  const [liveLoading, setLiveLoading] = useState(false)
  const [liveError, setLiveError] = useState('')
  const [liveProgress, setLiveProgress] = useState('')
  const [hasSearched, setHasSearched] = useState(false)

  // 年比較（今年vs去年）
  const [yoyLoading, setYoyLoading] = useState(false)
  const [yoyError, setYoyError] = useState('')
  const [yoyProgress, setYoyProgress] = useState('')
  const [yoyData, setYoyData] = useState(null) // { thisYear: {count,total}, lastYear: {count,total} }

  // データ取得
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [orderSnap, salonSnap] = await Promise.all([
        getDocs(collection(db, 'orders')),
        getDocs(collection(db, 'salons')),
      ])
      // 旧データ（isDeprecated === true）は集計対象から除外する
      setOrders(filterValidOrders(orderSnap.docs.map((d) => ({ id: d.id, ...d.data() }))))
      setSalons(salonSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
    } catch (e) {
      console.error('受注読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // サロン一覧（Bカート会員 + companyNameのユニーク + salons コレクションを統合）
  // 表記揺れ吸収: normalizeCompanyName でキー化し、代表名は pickDisplayName で選定
  // （"Salon'de  A" と "salon'de  A" を同一サロンに集約）
  const salonOptions = useMemo(() => {
    const buckets = new Map() // normKey -> Map<rawName, count>
    const add = (name) => {
      if (!name) return
      const k = normalizeCompanyName(name)
      if (!k) return
      if (!buckets.has(k)) buckets.set(k, new Map())
      const m = buckets.get(k)
      m.set(name, (m.get(name) || 0) + 1)
    }
    salons.forEach((s) => add(s.name))
    orders.forEach((o) => add(o.companyName))
    bcartCustomers.forEach((c) => add(c.comp_name || c.company_name || c.name))
    const display = [...buckets.values()].map((m) => pickDisplayName(m.entries()))
    return display.sort((a, b) => a.localeCompare(b, 'ja'))
  }, [salons, orders, bcartCustomers])

  // Bカート会員一覧を取得
  const loadBcartCustomers = useCallback(async () => {
    setLoadingCustomers(true)
    try {
      const customers = await fetchAllCustomers()
      setBcartCustomers(customers)
    } catch (e) {
      console.error('Bカート会員取得エラー:', e)
    } finally {
      setLoadingCustomers(false)
    }
  }, [])

  // 初回マウント時にBカート会員を取得
  useEffect(() => {
    loadBcartCustomers()
  }, [loadBcartCustomers])

  // 期間内に売上があったサロン名のセット（検索結果から）
  const salonsWithSales = useMemo(() => {
    const set = new Set()
    liveOrders.forEach((o) => {
      const name = o.customer_comp_name
      if (name) set.add(name)
    })
    return set
  }, [liveOrders])

  // 検索結果に含まれるサロン名（Bカート取得結果ベース）
  const salonsInResult = useMemo(() => {
    const set = new Set()
    liveOrders.forEach((o) => {
      const n = o.customer_comp_name
      if (n) set.add(n)
    })
    return set
  }, [liveOrders])

  // サロン候補（検索後は結果に含まれるサロンに絞る）
  const matchedSalons = useMemo(() => {
    let list = salonOptions
    // 検索済みなら結果に含まれるサロンだけ表示
    if (hasSearched) {
      list = list.filter((n) => salonsInResult.has(n))
    }
    if (onlyWithSales) {
      list = list.filter((n) => salonsWithSales.has(n))
    }
    if (salonKeyword.trim()) {
      const k = salonKeyword.toLowerCase()
      list = list.filter((n) => n.toLowerCase().includes(k))
    }
    return list
  }, [salonOptions, salonKeyword, onlyWithSales, salonsWithSales, hasSearched, salonsInResult])

  // 検索：Bカートから期間内の注文を取得（Bカート画面と完全一致）
  const handleSearch = useCallback(async () => {
    setLiveLoading(true)
    setLiveError('')
    setLiveProgress('Bカートから取得中...')
    setHasSearched(true)
    try {
      const sinceStr = dateFrom || daysAgo(30)
      const all = await fetchOrdersSince(sinceStr, (loaded, total) => {
        setLiveProgress(`Bカート取得中... ${loaded}/${total}件`)
      })
      const to = dateTo ? new Date(dateTo + 'T23:59:59') : null
      const filtered = to ? all.filter((o) => new Date(o.ordered_at) <= to) : all
      setLiveOrders(filtered)
      setLiveProgress(`✅ 取得完了: ${filtered.length}件`)
    } catch (e) {
      console.error('Bカート取得エラー:', e)
      setLiveError('Bカート取得失敗: ' + (e?.message || e))
    } finally {
      setLiveLoading(false)
    }
  }, [dateFrom, dateTo])

  // 今年 vs 去年 比較（年初〜本日 vs 去年同期間）
  const handleYoYCompare = useCallback(async () => {
    setYoyLoading(true)
    setYoyError('')
    setYoyProgress('')
    setYoyData(null)
    try {
      const now = new Date()
      const thisYear = now.getFullYear()
      const lastYear = thisYear - 1

      const thisYearStart = `${thisYear}-01-01`
      const lastYearStart = `${lastYear}-01-01`
      const lastYearEnd = new Date(lastYear, now.getMonth(), now.getDate(), 23, 59, 59)
      const thisYearEnd = new Date(thisYear, now.getMonth(), now.getDate(), 23, 59, 59)

      // 去年1/1から取得（今年データも含む）
      setYoyProgress('比較データ取得中...')
      const all = await fetchOrdersSince(lastYearStart, (loaded, total) => {
        setYoyProgress(`取得中... ${loaded}/${total}件`)
      })

      let tCount = 0, tTotal = 0, lCount = 0, lTotal = 0
      const tSalons = new Set(), lSalons = new Set()
      all.forEach((o) => {
        const d = new Date(o.ordered_at)
        const amt = Number(o.final_price) || 0
        const name = o.customer_comp_name
        if (selectedSalon && name !== selectedSalon) return
        if (d >= new Date(thisYearStart) && d <= thisYearEnd) {
          tCount++; tTotal += amt
          if (name) tSalons.add(name)
        } else if (d >= new Date(lastYearStart) && d <= lastYearEnd) {
          lCount++; lTotal += amt
          if (name) lSalons.add(name)
        }
      })

      setYoyData({
        thisYear: { count: tCount, total: tTotal, salons: tSalons.size, label: `${thisYear}年 (1/1〜${now.getMonth()+1}/${now.getDate()})` },
        lastYear: { count: lCount, total: lTotal, salons: lSalons.size, label: `${lastYear}年 (同期間)` },
      })
      setYoyProgress(`✅ 比較完了`)
    } catch (e) {
      console.error('年比較エラー:', e)
      setYoyError('比較失敗: ' + (e?.message || e))
    } finally {
      setYoyLoading(false)
    }
  }, [selectedSalon])

  // Bカート会員マスタを comp_name でマップ化（全フィールドを保持）
  const customerByName = useMemo(() => {
    const map = {}
    bcartCustomers.forEach((c) => {
      const name = c.comp_name || c.company_name
      if (name) {
        // 全フィールドの値を結合した検索用ブロブも用意
        const blob = Object.values(c).map((v) => String(v ?? '')).join(' ').toLowerCase()
        map[name] = { ...c, __blob: blob }
      }
    })
    return map
  }, [bcartCustomers])

  // 検索結果（常に Bカート直接取得データを使用）
  const filtered = useMemo(() => {
    const norm = (s) => String(s || '').toLowerCase()
    let list = liveOrders.map((o) => {
      const cust = customerByName[o.customer_comp_name] || {}
      // 候補フィールド（API仕様の差異に備え複数キーをチェック）
      const repLast  = cust.last_name || cust.family_name || cust.rep_last_name || ''
      const repFirst = cust.first_name || cust.given_name || cust.rep_first_name || ''
      const repLastK = cust.last_name_kana || cust.family_name_kana || cust.rep_last_name_kana || ''
      const repFirstK= cust.first_name_kana || cust.given_name_kana || cust.rep_first_name_kana || ''
      const tantoLast = cust.tanto_last_name || cust.contact_last_name || ''
      const tantoFirst= cust.tanto_first_name || cust.contact_first_name || ''
      const tantoLastK = cust.tanto_last_name_kana || cust.contact_last_name_kana || ''
      const tantoFirstK= cust.tanto_first_name_kana || cust.contact_first_name_kana || ''
      const tantoFull = o.customer_name || cust.tanto_name || cust.contact_name || ''
      const tantoFullK = cust.tanto_name_kana || cust.contact_name_kana || ''
      const pref = o.customer_pref || cust.pref || cust.prefecture || ''
      const email = o.customer_email || cust.email || cust.mail || ''
      return {
        id: 'live_' + o.id,
        bcartOrderNumber: o.code,
        bcartCode: o.code,
        bcartOrderId: o.id,
        companyName: o.customer_comp_name || '（不明）',
        contact: o.customer_name || '',
        orderDate: new Date(o.ordered_at),
        total: o.final_price || 0,
        subtotal: o.total_price || 0,
        shipping: o.shipping_cost || 0,
        tax: o.tax || 0,
        items: [],
        customerNote: o.customer_message || '',
        _repLast: repLast,
        _repFirst: repFirst,
        _repLastK: repLastK,
        _repFirstK: repFirstK,
        _tantoLast: tantoLast,
        _tantoFirst: tantoFirst,
        _tantoLastK: tantoLastK,
        _tantoFirstK: tantoFirstK,
        _tantoFull: tantoFull,
        _tantoFullK: tantoFullK,
        _pref: pref,
        _email: email,
      }
    })

    // 会員マスタ全フィールド横断検索（フィールド名差異を吸収）
    const matchBlob = (o, kw) => {
      if (!kw) return true
      const cust = customerByName[o.companyName]
      const blob = (cust?.__blob || '') + ' ' +
        norm(o.contact) + ' ' + norm(o.companyName) + ' ' +
        norm(o._email) + ' ' + norm(o._pref)
      return blob.includes(norm(kw))
    }

    // サロン選択は normalizeCompanyName で比較（表記揺れ吸収）
    if (selectedSalon) {
      const selKey = normalizeCompanyName(selectedSalon)
      list = list.filter((o) => normalizeCompanyName(o.companyName) === selKey)
    }
    if (filterRepLast)  list = list.filter((o) => matchBlob(o, filterRepLast))
    if (filterRepFirst) list = list.filter((o) => matchBlob(o, filterRepFirst))
    if (filterRepLastKana)  list = list.filter((o) => matchBlob(o, filterRepLastKana))
    if (filterRepFirstKana) list = list.filter((o) => matchBlob(o, filterRepFirstKana))
    if (filterTantoLast)  list = list.filter((o) => matchBlob(o, filterTantoLast))
    if (filterTantoFirst) list = list.filter((o) => matchBlob(o, filterTantoFirst))
    if (filterTantoLastKana) list = list.filter((o) => matchBlob(o, filterTantoLastKana))
    if (filterTantoFirstKana) list = list.filter((o) => matchBlob(o, filterTantoFirstKana))
    if (filterPref)  list = list.filter((o) => o._pref === filterPref || matchBlob(o, filterPref))
    if (filterEmail) list = list.filter((o) => norm(o._email).includes(norm(filterEmail)) || matchBlob(o, filterEmail))

    return list.sort((a, b) => b.orderDate - a.orderDate)
  }, [
    liveOrders, customerByName, selectedSalon,
    filterRepLast, filterRepFirst, filterRepLastKana, filterRepFirstKana,
    filterTantoLast, filterTantoFirst, filterTantoLastKana, filterTantoFirstKana,
    filterPref, filterEmail,
  ])

  // 集計
  const totalSales = filtered.reduce((s, o) => s + (Number(o.total) || 0), 0)
  const totalCount = filtered.length
  const avgOrder = totalCount > 0 ? Math.round(totalSales / totalCount) : 0

  // 月別集計
  const monthly = useMemo(() => {
    const m = {}
    filtered.forEach((o) => {
      const d = o.orderDate?.toDate ? o.orderDate.toDate() : new Date(o.orderDate)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!m[key]) m[key] = { count: 0, total: 0 }
      m[key].count += 1
      m[key].total += Number(o.total) || 0
    })
    return Object.entries(m).sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  // CSVダウンロード
  const downloadCsv = () => {
    const headers = ['受注日', 'サロン名', '注文番号', '金額', '商品数', '担当者', '備考']
    const rows = filtered.map((o) => [
      fmtDate(o.orderDate),
      o.companyName || '',
      o.bcartOrderNumber || o.bcartCode || '',
      o.total || 0,
      (o.items || []).length,
      o.contact || '',
      (o.customerNote || '').replace(/[\r\n,]/g, ' '),
    ])
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `サロン売上_${selectedSalon || '全件'}_${dateFrom}_${dateTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // サロン/代理店/取引先/倉庫ロールは閲覧不可（社内スタッフ以上のみ）
  const role = profile?.role
  const isInternal = role === 'master' || role === 'admin' || role === 'staff'
  if (!isInternal || isSalon || isDealer) {
    return <div className="p-6 text-gray-500">この画面の閲覧権限がありません。</div>
  }
  if (!isAdmin && !hasAccess('salonSales')) {
    return <div className="p-6 text-gray-500">この画面の閲覧権限がありません。</div>
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">サロン売上検索</h1>
          <p className="mt-1 text-sm text-gray-500">
            サロン別・期間別の売上を検索・集計できます
          </p>
        </div>
      </div>

      {/* 年比較サマリー */}
      {(yoyData || yoyProgress || yoyError) && (
        <div className="rounded-2xl border border-purple-200 bg-purple-50 p-5">
          <h2 className="mb-3 text-sm font-bold text-purple-900">📊 今年 vs 去年 売上比較{selectedSalon ? `（${selectedSalon}）` : '（全サロン）'}</h2>
          {yoyProgress && <div className="text-xs text-purple-700">{yoyProgress}</div>}
          {yoyError && <div className="text-xs text-red-700">{yoyError}</div>}
          {yoyData && (() => {
            const diff = yoyData.thisYear.total - yoyData.lastYear.total
            const pct = yoyData.lastYear.total > 0
              ? ((diff / yoyData.lastYear.total) * 100).toFixed(1)
              : '—'
            const up = diff >= 0
            return (
              <div className="mt-2 grid gap-3 md:grid-cols-3">
                <div className="rounded-xl bg-white p-4">
                  <div className="text-xs text-gray-500">{yoyData.thisYear.label}</div>
                  <div className="mt-1 text-2xl font-bold text-emerald-600">{fmtYen(yoyData.thisYear.total)}</div>
                  <div className="mt-1 text-xs text-gray-500">{yoyData.thisYear.count}件 / {yoyData.thisYear.salons}サロン</div>
                </div>
                <div className="rounded-xl bg-white p-4">
                  <div className="text-xs text-gray-500">{yoyData.lastYear.label}</div>
                  <div className="mt-1 text-2xl font-bold text-gray-700">{fmtYen(yoyData.lastYear.total)}</div>
                  <div className="mt-1 text-xs text-gray-500">{yoyData.lastYear.count}件 / {yoyData.lastYear.salons}サロン</div>
                </div>
                <div className={`rounded-xl p-4 ${up ? 'bg-emerald-100' : 'bg-red-100'}`}>
                  <div className="text-xs text-gray-600">前年比</div>
                  <div className={`mt-1 text-2xl font-bold ${up ? 'text-emerald-700' : 'text-red-700'}`}>
                    {up ? '▲' : '▼'} {fmtYen(Math.abs(diff))}
                  </div>
                  <div className={`mt-1 text-xs font-bold ${up ? 'text-emerald-700' : 'text-red-700'}`}>
                    {up ? '+' : ''}{pct}%
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* 検索条件 */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-bold text-gray-700">検索条件</h2>

        <div className="grid gap-4 md:grid-cols-3">
          {/* サロン選択 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">
              サロン名
              {loadingCustomers && (
                <span className="ml-2 text-[10px] text-indigo-500">Bカート会員取得中...</span>
              )}
            </label>
            <input
              type="text"
              value={salonKeyword}
              onChange={(e) => setSalonKeyword(e.target.value)}
              placeholder="サロン名で検索（空欄＝全サロン）"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <select
              value={selectedSalon}
              onChange={(e) => setSelectedSalon(e.target.value)}
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
              <option value="">
                — 全サロン ({matchedSalons.length}/{salonOptions.length}件) —
              </option>
              {matchedSalons.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={onlyWithSales}
                onChange={(e) => setOnlyWithSales(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              期間内に売上があったサロンのみ表示
            </label>
          </div>

          {/* 日付From + 検索ボタン */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">開始日</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={handleSearch}
              disabled={liveLoading}
              className="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
              {liveLoading ? '取得中...' : '🔍 検索'}
            </button>
            {liveProgress && <div className="mt-1 text-[11px] text-gray-600">{liveProgress}</div>}
            {liveError && <div className="mt-1 text-[11px] text-red-600">{liveError}</div>}
          </div>

          {/* 日付To + 年比較ボタン */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">終了日</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={handleYoYCompare}
              disabled={yoyLoading}
              className="mt-2 w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-50">
              {yoyLoading ? '比較中...' : '📊 今年 vs 去年 比較'}
            </button>
          </div>
        </div>

        {/* クイック期間ボタン */}
        {(() => {
          const d = new Date()
          const lastMonthD = new Date()
          lastMonthD.setMonth(lastMonthD.getMonth() - 1)
          const lmYear = lastMonthD.getFullYear()
          const lmMonth = String(lastMonthD.getMonth() + 1).padStart(2, '0')
          const lmLastDay = new Date(lmYear, lastMonthD.getMonth() + 1, 0).getDate()
          const lastYear = d.getFullYear() - 1
          const presets = [
            { key: '7d',   label: '過去7日',  from: daysAgo(7),  to: today() },
            { key: '30d',  label: '過去30日', from: daysAgo(30), to: today() },
            { key: '90d',  label: '過去90日', from: daysAgo(90), to: today() },
            { key: 'tm',   label: '今月',     from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, to: today() },
            { key: 'lm',   label: '先月',     from: `${lmYear}-${lmMonth}-01`, to: `${lmYear}-${lmMonth}-${lmLastDay}` },
            { key: 'ty',   label: '今年',     from: `${d.getFullYear()}-01-01`, to: today() },
            { key: 'ly',   label: '去年',     from: `${lastYear}-01-01`, to: `${lastYear}-12-31` },
          ]
          return (
            <div className="mt-3 flex flex-wrap gap-2">
              {presets.map((p) => {
                const active = dateFrom === p.from && dateTo === p.to
                return (
                  <button
                    key={p.key}
                    onClick={() => { setDateFrom(p.from); setDateTo(p.to) }}
                    className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${
                      active
                        ? 'border-indigo-600 bg-indigo-600 text-white shadow'
                        : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}>
                    {p.label}
                  </button>
                )
              })}
            </div>
          )
        })()}
        <div className="mt-2 text-[11px] text-gray-500">
          ※ 期間を選んだら「🔍 検索」を押してください
        </div>

        {/* 詳細検索 */}
        <div className="mt-4 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-800">
            <span>{showAdvanced ? '▼' : '▶'}</span> 詳細検索
            {(filterRepLast || filterRepFirst || filterRepLastKana || filterRepFirstKana ||
              filterTantoLast || filterTantoFirst || filterTantoLastKana || filterTantoFirstKana ||
              filterPref || filterEmail) && (
              <span className="ml-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] text-indigo-700">適用中</span>
            )}
          </button>
          {showAdvanced && (
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">代表者(姓)</label>
                <input type="text" value={filterRepLast} onChange={(e) => setFilterRepLast(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">代表者(名)</label>
                <input type="text" value={filterRepFirst} onChange={(e) => setFilterRepFirst(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">代表者(姓)カナ</label>
                <input type="text" value={filterRepLastKana} onChange={(e) => setFilterRepLastKana(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">代表者(名)カナ</label>
                <input type="text" value={filterRepFirstKana} onChange={(e) => setFilterRepFirstKana(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">担当者(姓)</label>
                <input type="text" value={filterTantoLast} onChange={(e) => setFilterTantoLast(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">担当者(名)</label>
                <input type="text" value={filterTantoFirst} onChange={(e) => setFilterTantoFirst(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">担当者(姓)カナ</label>
                <input type="text" value={filterTantoLastKana} onChange={(e) => setFilterTantoLastKana(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">担当者(名)カナ</label>
                <input type="text" value={filterTantoFirstKana} onChange={(e) => setFilterTantoFirstKana(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">都道府県</label>
                <select value={filterPref} onChange={(e) => setFilterPref(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                  <option value="">— すべて —</option>
                  {PREFECTURES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-600">メールアドレス</label>
                <input type="text" value={filterEmail} onChange={(e) => setFilterEmail(e.target.value)}
                  placeholder="部分一致"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => {
                    setFilterRepLast(''); setFilterRepFirst('')
                    setFilterRepLastKana(''); setFilterRepFirstKana('')
                    setFilterTantoLast(''); setFilterTantoFirst('')
                    setFilterTantoLastKana(''); setFilterTantoFirstKana('')
                    setFilterPref(''); setFilterEmail('')
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
                  詳細条件をクリア
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 集計サマリー */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">売上合計</div>
          <div className="mt-1 text-2xl font-bold text-emerald-600">{fmtYen(totalSales)}</div>
          <div className="mt-0.5 text-xs text-gray-400">
            {selectedSalon || '全サロン'} / {dateFrom} 〜 {dateTo}
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">注文件数</div>
          <div className="mt-1 text-2xl font-bold text-indigo-600">{totalCount} 件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">平均注文金額</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{fmtYen(avgOrder)}</div>
        </div>
      </div>

      {/* 月別売上 */}
      {monthly.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold text-gray-700">月別売上</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">年月</th>
                  <th className="px-3 py-2 text-right">注文件数</th>
                  <th className="px-3 py-2 text-right">売上合計</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map(([month, data]) => (
                  <tr key={month} className="border-b border-gray-100">
                    <td className="px-3 py-2 font-medium">{month}</td>
                    <td className="px-3 py-2 text-right">{data.count}</td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-600">
                      {fmtYen(data.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 注文一覧 */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-700">
            注文一覧 ({totalCount}件)
          </h2>
          <button
            onClick={downloadCsv}
            disabled={totalCount === 0}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            📥 CSV ダウンロード
          </button>
        </div>

        {liveLoading ? (
          <div className="py-8 text-center text-gray-400">{liveProgress || '取得中...'}</div>
        ) : !hasSearched ? (
          <div className="py-8 text-center text-gray-400">「🔍 検索」を押してください</div>
        ) : totalCount === 0 ? (
          <div className="py-8 text-center text-gray-400">該当する注文はありません</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">受注日</th>
                  <th className="px-3 py-2 text-left">サロン名</th>
                  <th className="px-3 py-2 text-left">注文番号</th>
                  <th className="px-3 py-2 text-right">金額</th>
                  <th className="px-3 py-2 text-right">商品数</th>
                  <th className="px-3 py-2 text-left">担当者</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((o) => (
                  <tr key={o.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(o.orderDate)}</td>
                    <td className="px-3 py-2 font-medium">{o.companyName || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600">
                      {o.bcartOrderNumber || o.bcartCode || '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-600">
                      {fmtYen(o.total)}
                    </td>
                    <td className="px-3 py-2 text-right">{(o.items || []).length}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{o.contact || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <div className="mt-3 text-center text-xs text-gray-400">
                ※ 表示は最新200件まで。CSVダウンロードで全件取得可能
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
