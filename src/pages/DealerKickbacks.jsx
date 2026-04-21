import React, { useEffect, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import { generateKickbackPdf } from '../lib/generateKickbackPdf.js'

function fmtYen(n) {
  if (n == null) return '—'
  return '\u00a5' + Number(n).toLocaleString()
}

function downloadKickbackCsv(stmt) {
  const BOM = '\uFEFF'
  const rows = [['サロン名', '注文日', '商品名', 'セット名', '数量', '単価', '小計', 'KB金額']]

  for (const entry of stmt.entries || []) {
    if (entry.orders) {
      for (const ord of entry.orders) {
        for (const item of ord.items || []) {
          rows.push([
            entry.salonName,
            ord.date,
            item.productName,
            item.setName || '',
            item.quantity,
            item.unitPrice,
            item.subtotal,
            item.kb,
          ])
        }
      }
    } else {
      rows.push([entry.salonName, '', '', '', '', '', entry.orderTotal, entry.kickbackAmount])
    }
  }

  rows.push([])
  rows.push(['KB金額合計', '', '', '', '', '', '', stmt.totalKickback])
  if (stmt.systemFee != null) {
    rows.push([`システム利用料（${stmt.kbOrderCount || ''}件×300）`, '', '', '', '', '', '', -stmt.systemFee])
    rows.push([`決済手数料3%（${stmt.creditCount || ''}件）`, '', '', '', '', '', '', -stmt.paymentFee])
    rows.push(['小計', '', '', '', '', '', '', stmt.subtotalAfterDeductions])
    rows.push(['消費税10%', '', '', '', '', '', '', stmt.tax])
    rows.push(['差引総合計', '', '', '', '', '', '', stmt.grandTotal])
  }

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

  const adjTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0)
  const baseAmount = stmt.dealerOrderTotal > 0 ? stmt.netSettlement : stmt.grandTotal
  const finalAmount = (baseAmount || 0) + adjTotal
  if (stmt.dealerOrderTotal > 0 || adjustments.length > 0) {
    rows.push([])
    rows.push(['最終精算額', '', '', '', '', '', '', finalAmount])
  }

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
        className="cursor-pointer border-b border-gray-50 hover:bg-violet-50/50"
        onClick={() => setOpen(!open)}
      >
        <td className="px-4 py-2 text-xs text-gray-400">
          <span className="mr-1">{open ? '▼' : '▶'}</span>
          {index + 1}
        </td>
        <td className="px-4 py-2 font-medium text-gray-900">{entry.salonName}</td>
        <td className="px-4 py-2 text-right">{entry.orderCount}回</td>
        <td className="px-4 py-2 text-right">{fmtYen(entry.orderTotal)}</td>
        <td className="px-4 py-2 text-right font-bold text-violet-500">{fmtYen(entry.kickbackAmount)}</td>
      </tr>
      {open &&
        entry.orders &&
        entry.orders.map((ord, oi) => (
          <React.Fragment key={oi}>
            <tr className="border-b border-gray-100 bg-violet-50/40">
              <td className="px-4 py-1.5"></td>
              <td className="px-4 py-1.5 text-xs font-bold text-gray-700">
                {ord.date}
                <span className="ml-2 font-normal text-gray-400">{ord.payment}</span>
              </td>
              <td className="px-4 py-1.5 text-right text-xs text-gray-500">{ord.items?.length || 0}品</td>
              <td className="px-4 py-1.5 text-right text-xs font-medium text-gray-700">{fmtYen(ord.total)}</td>
              <td className="px-4 py-1.5 text-right text-xs font-medium text-violet-500">{fmtYen(ord.kb)}</td>
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
                <td className="px-4 py-1 text-right text-xs text-violet-300">{fmtYen(item.kb)}</td>
              </tr>
            ))}
          </React.Fragment>
        ))}
    </>
  )
}

export default function DealerKickbacks() {
  const { profile } = useAuth()
  const dealerCode = profile?.dealerCode || ''
  const [kickbacks, setKickbacks] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!dealerCode) {
      setLoading(false)
      return
    }
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'kickbacks'), where('dealerCode', '==', dealerCode)),
        )
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        list.sort((a, b) => (b.month || '').localeCompare(a.month || ''))
        setKickbacks(list)
      } catch (e) {
        console.error('kickbacks 取得エラー:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [dealerCode])

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
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">キックバック清算書</h1>
        <p className="mt-1 text-xs text-gray-500">
          当月分は翌月以降に確定。過去分はいつでも PDF / CSV でダウンロードできます。
        </p>
      </div>

      {kickbacks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-12 text-center text-sm text-gray-400 shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
          キックバック清算書はまだありません
        </div>
      ) : (
        kickbacks.map((stmt) => (
          <div key={stmt.id} className="mb-8 rounded-2xl border border-gray-100 bg-white shadow-[0_1px_3px_rgba(17,24,39,0.04)]">
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-lg font-bold text-gray-900">{stmt.month}</span>
                  <span className="ml-2 text-sm text-gray-500">キックバック清算書</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      try {
                        await generateKickbackPdf(stmt)
                      } catch (e) {
                        alert('PDF生成に失敗しました: ' + e.message)
                      }
                    }}
                    className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-600 hover:bg-violet-100"
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
            </div>

            <div className="px-6 py-4">
              <div className="mb-6 rounded-2xl bg-gradient-to-br from-violet-500 to-violet-600 px-6 py-4 text-white shadow-[0_6px_20px_rgba(139,92,246,0.20)]">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs opacity-80">
                      {stmt.dealerOrderTotal > 0 ? '最終精算額（税込）' : '差引総合計（税込）'}
                    </div>
                    <div className="text-3xl font-bold">
                      {fmtYen(
                        stmt.dealerOrderTotal > 0 ? stmt.netSettlement : stmt.grandTotal || stmt.totalKickback,
                      )}
                    </div>
                  </div>
                </div>
                {stmt.grandTotal && (
                  <div className="border-t border-violet-300 pt-3 text-sm">
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
                      <div className="mt-1 border-t border-violet-300 pt-1 font-bold opacity-90">小計</div>
                      <div className="mt-1 border-t border-violet-300 pt-1 text-right font-bold">
                        {fmtYen(stmt.subtotalAfterDeductions)}
                      </div>
                      <div className="opacity-80">+ 消費税 10%</div>
                      <div className="text-right">{fmtYen(stmt.tax)}</div>
                      <div className="mt-1 border-t border-violet-300 pt-1 font-bold">KB清算額（税込）</div>
                      <div className="mt-1 border-t border-violet-300 pt-1 text-right font-bold">
                        {fmtYen(stmt.grandTotal)}
                      </div>
                      {stmt.dealerOrderTotal > 0 && (
                        <>
                          <div className="mt-2 border-t border-violet-200 pt-2 opacity-80">- 代理店注文額（税込）</div>
                          <div className="mt-2 border-t border-violet-200 pt-2 text-right">
                            -{fmtYen(stmt.dealerOrderTotal)}
                          </div>
                          <div className="mt-1 border-t-2 border-white pt-1 text-lg font-bold">最終精算額</div>
                          <div className="mt-1 border-t-2 border-white pt-1 text-right text-lg font-bold">
                            {fmtYen(stmt.netSettlement)}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

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
                    <tr className="border-t-2 border-violet-200 bg-violet-50">
                      <td className="px-4 py-3 font-bold" colSpan={3}>
                        合計（{stmt.entries?.length || 0}サロン）
                      </td>
                      <td className="px-4 py-3 text-right font-bold">{fmtYen(stmt.totalSales)}</td>
                      <td className="px-4 py-3 text-right text-lg font-bold text-violet-500">
                        {fmtYen(stmt.totalKickback)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
