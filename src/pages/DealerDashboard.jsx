import React, { useEffect, useState } from 'react'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { generateKickbackPdf } from '../lib/generateKickbackPdf.js'
import { fetchDealerSalonNamesFromBcart } from '../lib/dashboardAggregator.js'
import { fetchOrdersByMonth } from '../lib/bcartApi.js'

const TAB_SALES = 'sales'
const TAB_KICKBACK = 'kickback'

const DEFAULT_RATES = {
  dealerRate: 40,
  salonRate1to5: 65,
  salonRate6plus: 60,
  proRate: 65,
}

function getSalonRate(category, quantity, rates) {
  const r = rates || DEFAULT_RATES
  if (category === 'pro') return r.proRate / 100
  return quantity >= 6 ? r.salonRate6plus / 100 : r.salonRate1to5 / 100
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return '\u00a5' + Number(n).toLocaleString()
}

function fmtPct(n) {
  return Math.round(n * 100) + '%'
}

function downloadKickbackCsv(stmt) {
  const BOM = '\uFEFF'
  const rows = [['サロン名', '注文日', '商品名', 'セット名', '数量', '単価', '小計', 'KB金額']]

  for (const entry of (stmt.entries || [])) {
    if (entry.orders) {
      for (const ord of entry.orders) {
        for (const item of (ord.items || [])) {
          rows.push([
            entry.salonName, ord.date, item.productName, item.setName || '',
            item.quantity, item.unitPrice, item.subtotal, item.kb,
          ])
        }
      }
    } else {
      rows.push([entry.salonName, '', '', '', '', '', entry.orderTotal, entry.kickbackAmount])
    }
  }

  // 集計行
  rows.push([])
  rows.push(['KB金額合計', '', '', '', '', '', '', stmt.totalKickback])
  if (stmt.systemFee != null) {
    rows.push([`システム利用料（${stmt.kbOrderCount || ''}件×300）`, '', '', '', '', '', '', -stmt.systemFee])
    rows.push([`決済手数料3%（${stmt.creditCount || ''}件）`, '', '', '', '', '', '', -stmt.paymentFee])
    rows.push(['小計', '', '', '', '', '', '', stmt.subtotalAfterDeductions])
    rows.push(['消費税10%', '', '', '', '', '', '', stmt.tax])
    rows.push(['差引総合計', '', '', '', '', '', '', stmt.grandTotal])
  }

  // 代理店自身の注文
  if (stmt.dealerOrderTotal > 0) {
    rows.push([])
    rows.push(['--- 代理店自身の注文 ---'])
    if (stmt.dealerOrderItems) {
      for (const item of stmt.dealerOrderItems) {
        rows.push([item.productName || '', item.date || '', item.setName || '', '', item.quantity, item.unitPrice, item.subtotal, ''])
      }
    }
    rows.push(['代理店注文額（税込）', '', '', '', '', '', '', stmt.dealerOrderTotal])
  }

  // 調整項目
  const adjustments = (stmt.adjustments || []).filter((a) => a.label && a.amount !== 0)
  if (adjustments.length > 0) {
    rows.push([])
    rows.push(['--- 調整項目 ---'])
    for (const a of adjustments) {
      rows.push([a.label, '', '', '', '', '', '', a.amount])
    }
    const adjTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0)
    rows.push(['調整項目合計', '', '', '', '', '', '', adjTotal])
  }

  // 最終精算額
  const adjTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0)
  const baseAmount = stmt.dealerOrderTotal > 0 ? stmt.netSettlement : stmt.grandTotal
  const finalAmount = (baseAmount || 0) + adjTotal
  if (stmt.dealerOrderTotal > 0 || adjustments.length > 0) {
    rows.push([])
    rows.push(['最終精算額', '', '', '', '', '', '', finalAmount])
  }

  // Excel数式誤認防止
  const safeCsv = (v) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return /^[+=\-@]/.test(s) ? `"'${s}"` : `"${s}"`
  }
  const csv = BOM + rows.map((r) => r.map(safeCsv).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `KB清算_${stmt.dealerName || stmt.dealerCode}_${stmt.month}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function KbEntryRow({ entry, index }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr
        className="cursor-pointer border-b border-gray-50 hover:bg-gray-50"
        onClick={() => setOpen(!open)}
      >
        <td className="px-4 py-2 text-xs text-gray-400">
          <span className="mr-1">{open ? '▼' : '▶'}</span>{index + 1}
        </td>
        <td className="px-4 py-2 font-medium text-gray-900">{entry.salonName}</td>
        <td className="px-4 py-2 text-right">{entry.orderCount}回</td>
        <td className="px-4 py-2 text-right">{fmtYen(entry.orderTotal)}</td>
        <td className="px-4 py-2 text-right font-bold text-indigo-600">{fmtYen(entry.kickbackAmount)}</td>
      </tr>
      {open && entry.orders && entry.orders.map((ord, oi) => (
        <React.Fragment key={oi}>
          <tr className="border-b border-gray-100 bg-indigo-50/40">
            <td className="px-4 py-1.5"></td>
            <td className="px-4 py-1.5 text-xs font-bold text-gray-700">
              {ord.date}
              <span className="ml-2 font-normal text-gray-400">{ord.payment}</span>
            </td>
            <td className="px-4 py-1.5 text-right text-xs text-gray-500">{ord.items?.length || 0}品</td>
            <td className="px-4 py-1.5 text-right text-xs font-medium text-gray-700">{fmtYen(ord.total)}</td>
            <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-600">{fmtYen(ord.kb)}</td>
          </tr>
          {ord.items?.map((item, j) => (
            <tr key={j} className="border-b border-gray-50 bg-gray-50/30">
              <td className="px-4 py-1"></td>
              <td className="px-4 py-1 pl-10 text-xs text-gray-500">
                {item.productName}
                {item.setName && <span className="ml-1 text-gray-400">({item.setName})</span>}
              </td>
              <td className="px-4 py-1 text-right text-xs text-gray-400">
                {item.quantity}個 × {fmtYen(item.unitPrice)}
              </td>
              <td className="px-4 py-1 text-right text-xs text-gray-500">{fmtYen(item.subtotal)}</td>
              <td className="px-4 py-1 text-right text-xs text-indigo-400">{fmtYen(item.kb)}</td>
            </tr>
          ))}
        </React.Fragment>
      ))}
    </>
  )
}

export default function DealerDashboard() {
  const { profile } = useAuth()
  const [orders, setOrders] = useState([])
  const [kickbacks, setKickbacks] = useState([])
  const [dealerSalons, setDealerSalons] = useState([])
  const [rates, setRates] = useState(DEFAULT_RATES)
  const [loading, setLoading] = useState(true)
  const [now] = useState(new Date())
  const [tab, setTab] = useState(TAB_KICKBACK)

  const companyName = profile?.companyName || ''
  const dealerCode = profile?.dealerCode || ''


  useEffect(() => {
    if (!dealerCode) { setLoading(false); return }
    ;(async () => {
      try {
        // Bカートから所属サロン名を取得（customer_parent_id 経由、KB清算と同じロジック）
        const bcartNames = await fetchDealerSalonNamesFromBcart(dealerCode, { months: 6 })

        // dealerSalons からメタ情報（type: 'own' 等）を取得
        const salonSnap = await getDocs(
          query(collection(db, 'dealerSalons'), where('dealerCode', '==', dealerCode))
        )
        const metaByName = new Map()
        for (const d of salonSnap.docs) {
          const data = d.data()
          if (data.companyName) metaByName.set(data.companyName, { id: d.id, ...data })
        }

        // Bカート所属サロン名 + dealerSalons を統合
        const combinedNames = new Set([...bcartNames, ...metaByName.keys()])
        const salons = Array.from(combinedNames).map((name) => {
          const meta = metaByName.get(name)
          if (meta) return meta
          return { id: `auto-${name}`, companyName: name, dealerCode, type: 'sub' }
        })
        setDealerSalons(salons)

        // Bカートから直近12ヶ月の受注を取得（正確な最新データ、日次キャッシュ）
        const orderCacheKey = `dealerDashboardOrders:${dealerCode}:v1`
        const todayStr = new Date().toISOString().slice(0, 10)
        let allBcart = null
        try {
          const cached = JSON.parse(localStorage.getItem(orderCacheKey) || '{}')
          if (cached.date === todayStr && Array.isArray(cached.orders)) {
            allBcart = cached.orders.map((o) => ({
              ...o,
              orderDate: o.orderDate ? new Date(o.orderDate) : null,
            }))
          }
        } catch (e) { /* ignore */ }

        if (!allBcart) {
          allBcart = []
          const months = 12
          const nowDate = new Date()
          for (let i = 0; i < months; i += 1) {
            let ty = nowDate.getFullYear()
            let tm = nowDate.getMonth() - i
            while (tm < 0) { tm += 12; ty -= 1 }
            const ymStr = `${ty}-${String(tm + 1).padStart(2, '0')}`
            try {
              const raw = await fetchOrdersByMonth(ymStr)
              for (const o of raw) {
                if (String(o.customer_parent_id || '') !== String(dealerCode)) continue
                allBcart.push({
                  id: o.id,
                  companyName: (o.customer_comp_name || o.comp_name || o.customer_name || '').trim(),
                  total: Number(o.final_price ?? o.total_price) || 0,
                  subtotal: Number(o.total_price ?? o.final_price) || 0,
                  orderDate: o.ordered_at ? new Date(o.ordered_at.replace(' ', 'T')) : null,
                  orderNumber: o.order_no || o.order_number || '',
                  bcartOrderNumber: o.order_no || o.order_number || '',
                })
              }
            } catch (e) {
              console.warn('bcart month skip', ymStr, e.message)
            }
          }
          try {
            localStorage.setItem(orderCacheKey, JSON.stringify({
              date: todayStr,
              orders: allBcart.map((o) => ({
                ...o,
                orderDate: o.orderDate ? o.orderDate.toISOString() : null,
              })),
            }))
          } catch (e) { /* ignore */ }
        }
        setOrders(allBcart)

        // キックバック清算書（複合インデックス不要にするためorderByをクライアントで実行）
        const kbSnap = await getDocs(
          query(collection(db, 'kickbacks'), where('dealerCode', '==', dealerCode))
        )
        const kbList = kbSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        kbList.sort((a, b) => (b.month || '').localeCompare(a.month || ''))
        setKickbacks(kbList)

        // 掛け率設定を取得
        try {
          const settingsSnap = await getDoc(doc(db, 'settings', 'kickback'))
          if (settingsSnap.exists()) {
            const s = settingsSnap.data()
            setRates({
              dealerRate: s.dealerRate ?? DEFAULT_RATES.dealerRate,
              salonRate1to5: s.salonRate1to5 ?? DEFAULT_RATES.salonRate1to5,
              salonRate6plus: s.salonRate6plus ?? DEFAULT_RATES.salonRate6plus,
              proRate: s.proRate ?? DEFAULT_RATES.proRate,
            })
          }
        } catch {}
      } catch (e) {
        console.error('データ取得エラー:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [dealerCode])

  // 集計
  const totalSales = orders.reduce((s, o) => s + (Number(o.total) || 0), 0)
  const totalCount = orders.length

  const thisMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`
  const thisMonthOrders = orders.filter((o) => {
    const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
    if (!d) return false
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}` === thisMonth
  })
  const thisMonthSales = thisMonthOrders.reduce((s, o) => s + (Number(o.total) || 0), 0)

  // 月別集計
  const monthly = {}
  for (const o of orders) {
    const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
    if (!d) continue
    const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!monthly[key]) monthly[key] = { count: 0, total: 0 }
    monthly[key].count++
    monthly[key].total += Number(o.total) || 0
  }
  const monthlyKeys = Object.keys(monthly).sort().reverse()

  // サロン別売上集計
  const salonSales = {}
  for (const o of orders) {
    const name = o.companyName || '（不明）'
    if (!salonSales[name]) salonSales[name] = { count: 0, total: 0 }
    salonSales[name].count++
    salonSales[name].total += Number(o.total) || 0
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        読み込み中...
      </div>
    )
  }

  if (!dealerCode) {
    return (
      <div className="rounded-2xl border-2 border-yellow-200 bg-yellow-50 p-8 text-center">
        <div className="text-lg font-bold text-yellow-800">代理店情報が未設定です</div>
        <p className="mt-2 text-sm text-yellow-600">管理者にお問い合わせください。</p>
      </div>
    )
  }

  return (
    <div>
      {/* タブ */}
      <div className="mb-6 flex gap-2">
        <button
          onClick={() => setTab(TAB_SALES)}
          className={`rounded-lg px-5 py-2 text-sm font-medium transition-colors ${
            tab === TAB_SALES
              ? 'bg-indigo-600 text-white'
              : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          売上・注文
        </button>
        <button
          onClick={() => setTab(TAB_KICKBACK)}
          className={`rounded-lg px-5 py-2 text-sm font-medium transition-colors ${
            tab === TAB_KICKBACK
              ? 'bg-indigo-600 text-white'
              : 'border border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          キックバック清算書
          {kickbacks.length > 0 && (
            <span className="ml-2 rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">
              {kickbacks.length}
            </span>
          )}
        </button>
      </div>

      {tab === TAB_KICKBACK ? (
        /* キックバック清算書 */
        <div>
          {kickbacks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
              キックバック清算書はまだありません
            </div>
          ) : (
            kickbacks.map((stmt) => (
              <div key={stmt.id} className="mb-8 rounded-xl border border-gray-200 bg-white">
                {/* ヘッダー */}
                <div className="border-b border-gray-100 px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-lg font-bold text-gray-900">{stmt.month}</span>
                      <span className="ml-2 text-sm text-gray-500">キックバック清算書</span>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          await generateKickbackPdf(stmt)
                        } catch (e) {
                          alert('PDF生成に失敗しました: ' + e.message)
                        }
                      }}
                      className="rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      PDFダウンロード
                    </button>
                    <button
                      onClick={() => downloadKickbackCsv(stmt)}
                      className="rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100"
                    >
                      CSVダウンロード
                    </button>
                  </div>
                </div>

                <div className="px-6 py-4">
                  {/* 精算サマリー */}
                  <div className="mb-6 rounded-xl bg-indigo-600 px-6 py-4 text-white">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <div className="text-xs opacity-80">
                          {stmt.dealerOrderTotal > 0 ? '最終精算額（税込）' : '差引総合計（税込）'}
                        </div>
                        <div className="text-3xl font-bold">
                          {fmtYen(stmt.dealerOrderTotal > 0 ? stmt.netSettlement : (stmt.grandTotal || stmt.totalKickback))}
                        </div>
                      </div>
                    </div>
                    {stmt.grandTotal && (
                      <div className="border-t border-indigo-400 pt-3 text-sm">
                        <div className="grid grid-cols-2 gap-1">
                          <div className="opacity-80">KB金額合計</div>
                          <div className="text-right">{fmtYen(stmt.totalKickback)}</div>
                          {stmt.systemFee > 0 && (
                            <>
                              <div className="opacity-80">- システム利用料（{stmt.kbOrderCount || '—'}件）</div>
                              <div className="text-right">-{fmtYen(stmt.systemFee)}</div>
                            </>
                          )}
                          {stmt.paymentFee > 0 && (
                            <>
                              <div className="opacity-80">- 決済手数料（{stmt.creditCount || '—'}件分）</div>
                              <div className="text-right">-{fmtYen(stmt.paymentFee)}</div>
                            </>
                          )}
                          <div className="mt-1 border-t border-indigo-400 pt-1 font-bold opacity-90">小計</div>
                          <div className="mt-1 border-t border-indigo-400 pt-1 text-right font-bold">{fmtYen(stmt.subtotalAfterDeductions)}</div>
                          <div className="opacity-80">+ 消費税 10%</div>
                          <div className="text-right">{fmtYen(stmt.tax)}</div>
                          <div className="mt-1 border-t border-indigo-400 pt-1 font-bold">KB清算額（税込）</div>
                          <div className="mt-1 border-t border-indigo-400 pt-1 text-right font-bold">{fmtYen(stmt.grandTotal)}</div>
                          {stmt.dealerOrderTotal > 0 && (
                            <>
                              <div className="mt-2 border-t border-indigo-300 pt-2 opacity-80">- 代理店注文額（税込）</div>
                              <div className="mt-2 border-t border-indigo-300 pt-2 text-right">-{fmtYen(stmt.dealerOrderTotal)}</div>
                              <div className="mt-1 border-t-2 border-white pt-1 text-lg font-bold">最終精算額</div>
                              <div className="mt-1 border-t-2 border-white pt-1 text-right text-lg font-bold">{fmtYen(stmt.netSettlement)}</div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* サロン別明細テーブル */}
                  <div className="overflow-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                          <th className="px-4 py-2.5">#</th>
                          <th className="px-4 py-2.5">サロン名</th>
                          <th className="px-4 py-2.5 text-right">注文回数</th>
                          <th className="px-4 py-2.5 text-right">売上（税抜）</th>
                          <th className="px-4 py-2.5 text-right">KB金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stmt.entries?.map((entry, i) => (
                          <KbEntryRow key={i} entry={entry} index={i} />
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-indigo-200 bg-indigo-50">
                          <td className="px-4 py-3 font-bold" colSpan={3}>合計（{stmt.entries?.length || 0}サロン）</td>
                          <td className="px-4 py-3 text-right font-bold">{fmtYen(stmt.totalSales)}</td>
                          <td className="px-4 py-3 text-right text-lg font-bold text-indigo-600">{fmtYen(stmt.totalKickback)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {/* サマリーカード */}
          <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-200 bg-white p-6">
              <div className="text-xs text-gray-500">累計注文数</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">{totalCount}件</div>
            </div>
            <div className="rounded-2xl border border-gray-200 bg-white p-6">
              <div className="text-xs text-gray-500">累計売上</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">{fmtYen(totalSales)}</div>
            </div>
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-6">
              <div className="text-xs text-indigo-600">今月の売上</div>
              <div className="mt-2 text-3xl font-bold text-indigo-700">{fmtYen(thisMonthSales)}</div>
              <div className="mt-1 text-xs text-indigo-400">{thisMonthOrders.length}件</div>
            </div>
          </div>

          {/* 所属サロン別売上 */}
          {dealerSalons.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-4 text-sm font-bold text-gray-700">
                所属サロン別売上（{dealerSalons.length}社）
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {dealerSalons.map((salon) => {
                  const data = salonSales[salon.companyName] || { count: 0, total: 0 }
                  return (
                    <div key={salon.id} className="rounded-xl border border-gray-200 bg-white p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                          salon.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                        }`}>
                          {salon.type === 'own' ? '自社' : '配下'}
                        </span>
                        <span className="text-sm font-medium text-gray-900">{salon.companyName}</span>
                      </div>
                      <div className="flex gap-6 text-sm">
                        <div>
                          <span className="text-xs text-gray-500">注文数</span>
                          <div className="font-bold text-gray-900">{data.count}件</div>
                        </div>
                        <div>
                          <span className="text-xs text-gray-500">累計売上</span>
                          <div className="font-bold text-gray-900">{fmtYen(data.total)}</div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 月別売上 */}
          <div className="mb-8">
            <h2 className="mb-4 text-sm font-bold text-gray-700">月別売上推移</h2>
            <div className="flex flex-wrap gap-3">
              {monthlyKeys.length === 0 ? (
                <span className="text-sm text-gray-400">データなし</span>
              ) : (
                monthlyKeys.map((k) => (
                  <div key={k} className="rounded-xl border border-gray-200 bg-white px-5 py-3 text-center">
                    <div className="text-xs text-gray-500">{k}</div>
                    <div className="mt-1 text-lg font-bold text-gray-900">{fmtYen(monthly[k].total)}</div>
                    <div className="text-xs text-gray-400">{monthly[k].count}件</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 注文一覧 */}
          <h2 className="mb-4 text-sm font-bold text-gray-700">注文履歴</h2>
          <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
            {orders.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                注文データがありません
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                    <th className="px-4 py-3">サロン名</th>
                    <th className="px-4 py-3">注文番号</th>
                    <th className="px-4 py-3">注文日</th>
                    <th className="px-4 py-3 text-right">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{o.companyName || '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs">{o.orderNumber || o.bcartOrderNumber || '—'}</td>
                      <td className="px-4 py-3">{fmtDate(o.orderDate)}</td>
                      <td className="px-4 py-3 text-right font-bold">{fmtYen(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
