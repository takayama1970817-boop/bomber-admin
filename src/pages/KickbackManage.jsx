import React, { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase.js'
import { generateKickbackPdfBase64 } from '../lib/generateKickbackPdf.js'
import { generateKickbackPdf } from '../lib/generateKickbackPdf.js'
import { downloadEml } from '../lib/generateEml.js'
import { fetchOrdersByMonth, fetchOrderProductsBatch } from '../lib/bcartApi.js'

function fmtYen(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}

// KB清算データをCSV文字列に変換してダウンロード
function downloadKickbackCsv(calcResult, dealerCode, month, adjustments = []) {
  const BOM = '\uFEFF'
  const rows = [['サロン名', '注文日', '商品名', 'セット名', '数量', '単価', '小計', 'KB金額']]

  for (const entry of calcResult.entries) {
    if (entry.orders) {
      for (const ord of entry.orders) {
        for (const item of ord.items) {
          rows.push([
            entry.salonName, ord.date, item.productName, item.setName,
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
  rows.push(['KB金額合計', '', '', '', '', '', '', calcResult.totalKickback])
  if (calcResult.systemFee != null) {
    rows.push([`システム利用料（${calcResult.kbOrderCount}件×300）`, '', '', '', '', '', '', -calcResult.systemFee])
    rows.push([`決済手数料3%（${calcResult.creditCount}件）`, '', '', '', '', '', '', -calcResult.paymentFee])
    rows.push(['小計', '', '', '', '', '', '', calcResult.subtotalAfterDeductions])
    rows.push(['消費税10%', '', '', '', '', '', '', calcResult.tax])
    rows.push(['差引総合計', '', '', '', '', '', '', calcResult.grandTotal])
  }

  // 代理店注文
  if (calcResult.dealerOrderTotal > 0) {
    rows.push([])
    rows.push(['--- 代理店自身の注文 ---'])
    if (calcResult.dealerOrderItems) {
      for (const item of calcResult.dealerOrderItems) {
        rows.push([item.productName || '', item.date || '', item.setName || '', '', item.quantity, item.unitPrice, item.subtotal, ''])
      }
    }
    rows.push(['代理店注文額（税込）', '', '', '', '', '', '', calcResult.dealerOrderTotal])
  }

  // 調整項目
  const validAdj = adjustments.filter((a) => a.label && a.amount !== 0)
  if (validAdj.length > 0) {
    rows.push([])
    rows.push(['--- 調整項目 ---'])
    for (const a of validAdj) {
      rows.push([a.label, '', '', '', '', '', '', a.amount])
    }
    const adjTotal = validAdj.reduce((s, a) => s + (a.amount || 0), 0)
    rows.push(['調整項目合計', '', '', '', '', '', '', adjTotal])
  }

  // 最終精算額
  const adjTotal = validAdj.reduce((s, a) => s + (a.amount || 0), 0)
  const baseAmount = calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : calcResult.grandTotal
  const finalAmount = baseAmount + adjTotal
  if (calcResult.dealerOrderTotal > 0 || validAdj.length > 0) {
    rows.push([])
    rows.push(['最終精算額', '', '', '', '', '', '', finalAmount])
  }

  // Excel数式誤認防止: +, -, =, @ で始まるセルは先頭にシングルクォート付与
  const safeCsv = (v) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return /^[+=\-@]/.test(s) ? `"'${s}"` : `"${s}"`
  }
  const csv = BOM + rows.map((r) => r.map(safeCsv).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `KB清算_${dealerCode}_${month.replace('-', '')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// キックバック計算式を表（CSV）にまとめてダウンロード
function downloadKickbackFormula(kbSettings) {
  const s = { ...DEFAULT_KB_SETTINGS, ...(kbSettings || {}) }
  const stdPct = (parseRate(s.standardRate) * 100).toFixed(2)
  const cmpPct = (parseRate(s.campaignRate) * 100).toFixed(2)
  const BOM = '\uFEFF'
  const rows = []
  rows.push(['キックバック計算式 まとめ表'])
  rows.push([])
  rows.push(['■ 基本料率・控除設定'])
  rows.push(['項目', '設定値', '説明'])
  rows.push(['通常KB率', `${s.standardRate}（≒${stdPct}%）`, '通常注文の利益分配率'])
  rows.push(['キャンペーンKB率', `${s.campaignRate}（≒${cmpPct}%）`, 'キャンペーン対象注文の利益分配率'])
  rows.push(['システム利用料', `${s.systemFeePerOrder}円 × KB対象注文件数`, '注文1件あたり差し引き'])
  rows.push(['決済手数料', `売上 × ${s.paymentFeeRate}%`, `対象決済: ${(s.paymentFeeMethods || []).join(' / ')}`])
  rows.push(['消費税', '10%', '小計に対して加算'])
  rows.push(['有効セット名', (s.validSetNames || []).join(' / '), 'これ以外はKB対象外'])
  rows.push([])
  rows.push(['■ サロン1件あたりの計算手順'])
  rows.push(['手順', '計算式'])
  rows.push(['① 商品小計', '単価 × 数量'])
  rows.push(['② KB金額（通常）', `商品小計 × ${s.standardRate}`])
  rows.push(['② KB金額（キャンペーン）', `商品小計 × ${s.campaignRate}`])
  rows.push(['③ サロン合計KB', '全注文のKB金額の合計'])
  rows.push([])
  rows.push(['■ 代理店ごとの最終精算額'])
  rows.push(['行', '計算式'])
  rows.push(['A. KB金額合計', '全サロンのKB金額を合算'])
  rows.push(['B. システム利用料', `KB対象注文件数 × ${s.systemFeePerOrder}円`])
  rows.push(['C. 決済手数料', `該当注文の売上合計 × ${s.paymentFeeRate}%`])
  rows.push(['D. 小計', 'A − B − C'])
  rows.push(['E. 消費税', 'D × 10%'])
  rows.push(['F. 差引総合計', 'D + E'])
  rows.push(['G. 代理店自身の注文額（税込）', '代理店本人の購入合計'])
  rows.push(['H. ネット精算額', 'F − G'])
  rows.push(['I. 調整項目', '手動加減算（運賃補填・返品調整など）'])
  rows.push(['J. 最終精算額', 'H + I（代理店注文がない場合は F + I）'])

  const safeCsv = (v) => {
    const str = String(v ?? '').replace(/"/g, '""')
    return /^[+=\-@]/.test(str) ? `"'${str}"` : `"${str}"`
  }
  const csv = BOM + rows.map((r) => r.map(safeCsv).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `KB計算式_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const DEFAULT_KB_SETTINGS = {
  standardRate: '5/13',
  campaignRate: '1/3',
  systemFeePerOrder: 300,
  paymentFeeRate: 3,
  paymentFeeMethods: ['クレジット', 'Paid', '代金引換'],
  validSetNames: ['単品販売', 'ミカエル', 'エンジェル'],
}

function parseRate(rateStr) {
  if (!rateStr) return 0
  const parts = String(rateStr).split('/')
  if (parts.length === 2) return Number(parts[0]) / Number(parts[1])
  return Number(rateStr) || 0
}

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// KB金額を計算
// 定価 ×（サロン価格率 − 代理店原価率）× 数量
// サロン価格率: 1〜5個 → 65%、6個以上 → 60%
// 代理店原価率: 代理店ごと設定（dealerRate）
// standardPrice: 同月の同商品の最高単価（定価）
// allStdPrices: 全商品の定価セット（6+1セット価格の判定用）
function calcKbFromProduct(productName, setName, unitPrice, quantity, standardPrice, kbSettings, allStdPrices, dealerRate) {
  // 代理店原価率が設定されていれば新方式（定価ベース）
  // standardPrice = 同月の最高単価 = サロン価格（定価の65%）
  // 定価 = standardPrice ÷ 0.65
  if (dealerRate != null && dealerRate > 0) {
    const text = `${productName || ''} ${setName || ''}`
    const is6set = /6\+1|6＋1|ミカエル/.test(text)
    const isAngel = /エンジェル/.test(text)

    if (is6set) {
      // ミカエル/6+1セット: セット価格 = 単品サロン6個以上価格 × 6
      // 単品定価 = (セット価格 ÷ 6) ÷ 0.60
      const perItemSalonPrice = unitPrice / 6
      const perItemRetail = perItemSalonPrice / 0.60
      const kbPerSet = Math.round(perItemRetail * (0.60 - dealerRate / 100) * 6)
      return kbPerSet * quantity
    }

    if (standardPrice > 0) {
      const retailPrice = standardPrice / 0.65  // 定価を逆算
      // エンジェル or 業務用 = 何個でも常に65%、店販用単品 = 1〜5個65%、6個以上60%
      const isProUse = isAngel || /業務用/.test(text)
      const salonRate = isProUse ? 0.65 : (quantity >= 6 ? 0.60 : 0.65)
      return Math.round(retailPrice * (salonRate - dealerRate / 100) * quantity)
    }
  }

  // 従来方式（フォールバック: 5/13, 1/3）
  const s = kbSettings || DEFAULT_KB_SETTINGS
  const text = `${productName || ''} ${setName || ''}`
  const isCampaignByName = /6\+1|6＋1|キャンペーン/.test(text)
  const isCampaignByPrice = standardPrice && unitPrice < standardPrice

  const stdRate = parseRate(s.standardRate)   // 5/13
  const cmpRate = parseRate(s.campaignRate)   // 1/3

  if (isCampaignByPrice) {
    return Math.round(unitPrice * quantity * cmpRate)
  } else if (isCampaignByName) {
    const perUnit = Math.round(unitPrice / 6)
    const isStandardPriced = allStdPrices && allStdPrices.has(perUnit)
    if (isStandardPriced) {
      return Math.round(unitPrice * quantity * (12 / 13) * cmpRate)
    }
    return Math.round(unitPrice * quantity * cmpRate)
  } else {
    return Math.round(unitPrice * quantity * stdRate)
  }
}

// CSVテキストをパース（Shift-JIS対応はFileReader側で処理）
function parseCsvText(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const fields = []
    let field = ''
    let inQuote = false
    for (const ch of lines[i]) {
      if (ch === '"') {
        inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        fields.push(field.trim())
        field = ''
      } else {
        field += ch
      }
    }
    fields.push(field.trim())

    if (fields.length >= 9) {
      rows.push({
        dealerCode: fields[0],
        orderedAt: fields[1],
        payment: fields[2],
        companyName: fields[3],
        productName: fields[4],
        setName: fields[5],
        quantity: parseInt(fields[6]) || 0,
        unitPrice: parseInt(fields[7]) || 0,
        subtotal: parseInt(fields[8]) || 0,
        status: fields[9] || '',
      })
    }
  }
  return rows
}

export default function KickbackManage() {
  const [searchParams] = useSearchParams()
  const initialDealer = searchParams.get('dealer') || ''

  const [dealers, setDealers] = useState([])
  const [selectedCode, setSelectedCode] = useState(initialDealer)
  const [month, setMonth] = useState(currentMonth())
  const [loading, setLoading] = useState(true)

  // サロン紐付け
  const [salonLinks, setSalonLinks] = useState([])
  const [allCompanies, setAllCompanies] = useState([])
  const [allOrders, setAllOrders] = useState([])

  // 紐付けフォーム
  const [linkCompany, setLinkCompany] = useState('')
  const [linkType, setLinkType] = useState('sub')

  // 清算書
  const [statements, setStatements] = useState([])

  // 計算結果（API or CSV共通）
  const [calcResult, setCalcResult] = useState(null)
  const [calcSource, setCalcSource] = useState(null) // 'api' or 'csv'
  const [expandedSalons, setExpandedSalons] = useState(new Set()) // 展開中のサロン名
  const fileRef = useRef(null)

  // 調整項目（固定＋都度）
  const [adjustments, setAdjustments] = useState([])

  // API取得中
  const [apiFetching, setApiFetching] = useState(false)
  const [apiProgress, setApiProgress] = useState('')

  // 会社設定（印影・会社情報）
  const [stampDataUrl, setStampDataUrl] = useState(null)
  const [companyInfo, setCompanyInfo] = useState(null)
  const [kbGroups, setKbGroups] = useState([])  // グループ配列
  const [kbSettings, setKbSettings] = useState({ ...DEFAULT_KB_SETTINGS })

  // 初期データ取得
  useEffect(() => {
    ;(async () => {
      try {
        const [dealerSnap, linkSnap, orderSnap] = await Promise.all([
          getDocs(collection(db, 'allowedEmails')),
          getDocs(collection(db, 'dealerSalons')),
          getDocs(query(collection(db, 'orders'), orderBy('orderDate', 'desc'))),
        ])

        const dealerList = dealerSnap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((d) => d.role === 'dealer' && d.dealerCode)
        setDealers(dealerList)

        setSalonLinks(linkSnap.docs.map((d) => ({ id: d.id, ...d.data() })))

        const orders = orderSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        setAllOrders(orders)

        const names = [...new Set(orders.map((o) => o.companyName).filter(Boolean))]
        setAllCompanies(names.sort())

        // 設定を読み込み（失敗しても他の処理に影響させない）
        try {
          const [stampDoc, companyDoc, kbDoc] = await Promise.all([
            getDoc(doc(db, 'settings', 'companyStamp')),
            getDoc(doc(db, 'settings', 'company')),
            getDoc(doc(db, 'settings', 'kickback')),
          ])
          if (stampDoc.exists() && stampDoc.data().dataUrl) {
            setStampDataUrl(stampDoc.data().dataUrl)
          }
          if (companyDoc.exists()) {
            setCompanyInfo(companyDoc.data())
          }
          if (kbDoc.exists()) {
            const kbData = kbDoc.data()
            if (kbData.groups && Array.isArray(kbData.groups)) {
              setKbGroups(kbData.groups)
              // デフォルトはグループA
              const groupA = kbData.groups.find((g) => g.id === 'A') || kbData.groups[0]
              if (groupA) setKbSettings({ ...DEFAULT_KB_SETTINGS, ...groupA })
            } else {
              // 旧形式（グループなし）
              setKbSettings({ ...DEFAULT_KB_SETTINGS, ...kbData })
            }
          }
        } catch (e) {
          console.warn('設定の読み込みスキップ:', e.message)
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const selectedDealer = dealers.find((d) => d.dealerCode === selectedCode)
  const dealerSalons = salonLinks.filter((s) => s.dealerCode === selectedCode)

  // 代理店変更時に固定調整項目をセット
  useEffect(() => {
    if (selectedDealer?.fixedAdjustments?.length > 0) {
      setAdjustments(selectedDealer.fixedAdjustments.map((a) => ({ ...a, fixed: true })))
    } else {
      setAdjustments([])
    }
  }, [selectedCode, dealers]) // eslint-disable-line
  const unlinkedCompanies = allCompanies.filter((c) => !salonLinks.some((s) => s.companyName === c))

  // === BカートAPI取得 ===
  const handleApiFetch = async () => {
    if (!month) { alert('対象月を選択してください'); return }
    setApiFetching(true)
    setApiProgress('受注データを取得中...')
    try {
      // 1. 月指定で受注一覧を取得（全ページ）
      const allOrders = await fetchOrdersByMonth(month, (fetched, total) => {
        setApiProgress(`受注データ取得中... ${fetched}/${total}件`)
      })
      if (allOrders.length === 0) {
        alert(`${month} の受注データが見つかりません`)
        return
      }

      // 2. 代理店コードで絞り込み（customer_parent_id で配下サロンを特定）
      // includeOwnOrders が ON の場合、代理店自身の会社名の注文も取得対象に追加
      const ownCompanyNames = []
      if (selectedDealer?.includeOwnOrders) {
        const ownFromLinks = salonLinks
          .filter((s) => s.dealerCode === selectedCode && s.type === 'own')
          .map((s) => s.companyName.replace(/\s/g, ''))
        const dealerCompName = (selectedDealer?.companyName || '').replace(/\s/g, '')
        ownCompanyNames.push(...new Set([...ownFromLinks, ...(dealerCompName ? [dealerCompName] : [])]))
      }

      const allDealerOrders = selectedCode
        ? allOrders.filter((o) => {
            // 配下サロンの注文
            if (String(o.customer_parent_id || '') === String(selectedCode)) return true
            // 代理店自身の注文（会社名一致）
            if (ownCompanyNames.length > 0) {
              const compName = (o.customer_comp_name || '').replace(/\s/g, '')
              if (ownCompanyNames.some((n) => compName.includes(n) || n.includes(compName))) return true
            }
            return false
          })
        : allOrders

      if (allDealerOrders.length === 0) {
        alert(`${month} の ${selectedCode} 所属の受注データが見つかりません（全${allOrders.length}件中）`)
        return
      }

      // 2b. 代理店自身の注文を分離（includeOwnOrders が ON の代理店のみ）
      const dealerOwnOrders = []
      const orders = []
      if (selectedDealer?.includeOwnOrders && ownCompanyNames.length > 0) {
        for (const o of allDealerOrders) {
          const compName = (o.customer_comp_name || '').replace(/\s/g, '')
          if (ownCompanyNames.some((n) => compName.includes(n) || n.includes(compName))) {
            dealerOwnOrders.push(o)
          } else {
            orders.push(o)
          }
        }
      } else {
        orders.push(...allDealerOrders)
      }
      setApiProgress(`${orders.length}件のサロン受注 + ${dealerOwnOrders.length}件の代理店自身の注文。明細を取得中...`)

      // 3. 受注IDから明細を一括取得（サロン + 代理店自身）
      const allOrderIds = [...orders.map((o) => o.id), ...dealerOwnOrders.map((o) => o.id)]
      const allProducts = await fetchOrderProductsBatch(allOrderIds, (done, total) => {
        setApiProgress(`明細取得中... ${done}/${total}受注`)
      })
      // サロン分と代理店自身分を分離
      const salonOrderIdSet = new Set(orders.map((o) => o.id))
      const products = allProducts.filter((p) => salonOrderIdSet.has(p.order_id))
      const dealerOwnProducts = allProducts.filter((p) => !salonOrderIdSet.has(p.order_id))
      setApiProgress(`${products.length}件のサロン明細 + ${dealerOwnProducts.length}件の代理店明細。計算中...`)

      // 4. 受注IDから会社名・日付をマッピング
      const orderMap = {}
      for (const o of orders) {
        orderMap[o.id] = {
          companyName: o.customer_comp_name || '',
          orderedAt: o.ordered_at || '',
          payment: o.payment || '',
          status: o.status || '',
        }
      }

      // 5. 代理店のKBグループに応じた設定を適用
      const dealerKbGroup = selectedDealer?.kbGroup || 'A'
      const groupSettings = kbGroups.find((g) => g.id === dealerKbGroup) || kbSettings
      const activeSettings = { ...DEFAULT_KB_SETTINGS, ...groupSettings }
      const dealerKbRate = selectedDealer?.kbRate
      const isSimplePercentGroup = activeSettings.simplePercent > 0 // グループBなど: 配下サロン価格の固定%

      const validSetRegex = new RegExp((activeSettings.validSetNames || []).join('|'))
      const feeMethods = activeSettings.paymentFeeMethods || ['クレジットカード', 'Paid', '代金引換']
      const feeRate = (activeSettings.paymentFeeRate || 3) / 100
      const systemFeeUnit = activeSettings.systemFeePerOrder || 300

      // 5a. 商品ごとの最高単価（定価）を構築（キャンペーン判定用）
      const standardPriceMap = {}
      for (const p of products) {
        const key = p.product_name || ''
        const price = p.unit_price || 0
        if (!standardPriceMap[key] || price > standardPriceMap[key]) {
          standardPriceMap[key] = price
        }
      }
      // 全定価のセット（6+1セット価格が標準単価ベースか判定用）
      const allStdPrices = new Set(Object.values(standardPriceMap))

      // 5b. サロン別に集計 + KB対象注文IDを追跡
      const salonMap = {}
      let paperBagTotal = 0
      const kbOrderIds = new Set() // KB対象商品を含む注文ID

      for (const p of products) {
        const order = orderMap[p.order_id]
        if (!order) continue

        const productName = p.product_name || ''
        const setName = p.set_name || ''

        // 紙袋は除外（商品名 or セット名で判定）
        if (/紙袋/.test(productName) || /紙袋/.test(setName)) {
          paperBagTotal += (p.unit_price || 0) * (p.order_pro_count || 0)
          continue
        }

        // KB対象セット名のみ計算
        if (!validSetRegex.test(setName)) {
          continue
        }

        // この注文はKB対象
        kbOrderIds.add(p.order_id)

        const name = order.companyName || '（不明）'
        if (!salonMap[name]) {
          salonMap[name] = { orderDates: new Set(), total: 0, kb: 0, orderGroups: {} }
        }

        const date = order.orderedAt?.split(' ')[0] || ''
        if (date) salonMap[name].orderDates.add(date)

        const subtotal = (p.unit_price || 0) * (p.order_pro_count || 0)
        salonMap[name].total += subtotal

        const stdPrice = standardPriceMap[productName] || 0
        const kb = isSimplePercentGroup
          ? Math.round(subtotal * (activeSettings.simplePercent / 100))
          : calcKbFromProduct(productName, setName, p.unit_price || 0, p.order_pro_count || 0, stdPrice, activeSettings, allStdPrices, dealerKbRate)
        salonMap[name].kb += kb

        // 注文日ごとにグループ化
        const groupKey = `${date}_${p.order_id}`
        if (!salonMap[name].orderGroups[groupKey]) {
          salonMap[name].orderGroups[groupKey] = { date, payment: order.payment || '', items: [], total: 0, kb: 0 }
        }
        salonMap[name].orderGroups[groupKey].items.push({
          productName,
          setName,
          unitPrice: p.unit_price || 0,
          quantity: p.order_pro_count || 0,
          subtotal,
          kb,
        })
        salonMap[name].orderGroups[groupKey].total += subtotal
        salonMap[name].orderGroups[groupKey].kb += kb
      }

      const entries = Object.entries(salonMap)
        .map(([name, data]) => ({
          salonName: name,
          type: 'sub',
          orderCount: data.orderDates.size,
          orderTotal: data.total,
          kickbackAmount: data.kb,
          orders: Object.values(data.orderGroups).sort((a, b) => a.date.localeCompare(b.date)),
        }))
        .sort((a, b) => b.kickbackAmount - a.kickbackAmount)

      const totalKb = entries.reduce((s, e) => s + e.kickbackAmount, 0)
      const totalSales = entries.reduce((s, e) => s + e.orderTotal, 0)

      // 6. KB対象注文のうち対象決済方法の売上で決済手数料を計算
      const paymentTypes = {}
      for (const o of orders) {
        if (kbOrderIds.has(o.id)) {
          const pm = o.payment || '（未設定）'
          paymentTypes[pm] = (paymentTypes[pm] || 0) + 1
        }
      }
      const feeTargetOrderIds = new Set(
        orders.filter((o) => kbOrderIds.has(o.id) && feeMethods.some((m) => {
          const pm = o.payment || ''
          return pm.includes(m) || m.includes(pm)
        })).map((o) => o.id)
      )
      let feeTargetSalesTotal = 0
      for (const p of products) {
        const pSetName = p.set_name || ''
        if (feeTargetOrderIds.has(p.order_id) && !/紙袋/.test(p.product_name || '') && validSetRegex.test(pSetName)) {
          feeTargetSalesTotal += (p.unit_price || 0) * (p.order_pro_count || 0)
        }
      }
      const paymentFee = Math.round(feeTargetSalesTotal * feeRate)
      const kbOrderCount = kbOrderIds.size

      // 7. 清算額計算
      // システム利用料 = KB対象注文件数 × 設定値
      const systemFee = kbOrderCount * systemFeeUnit
      const subtotalAfterDeductions = totalKb - systemFee - paymentFee
      const tax = Math.round(subtotalAfterDeductions * 0.10)
      const grandTotal = subtotalAfterDeductions + tax

      // 8. 代理店自身の注文集計（送料含む、紙袋含む → 請求書と同じ全額）
      const dealerOrderMap = {}
      for (const o of dealerOwnOrders) {
        dealerOrderMap[o.id] = { orderedAt: o.ordered_at || '', payment: o.payment || '' }
      }
      let dealerOrderSubtotal = 0  // 税抜合計
      const dealerOrderItems = []
      for (const p of dealerOwnProducts) {
        const dOrder = dealerOrderMap[p.order_id]
        if (!dOrder) continue
        const sub = (p.unit_price || 0) * (p.order_pro_count || 0)
        dealerOrderSubtotal += sub
        dealerOrderItems.push({
          date: (dOrder.orderedAt || '').split(' ')[0],
          productName: p.product_name || '',
          setName: p.set_name || '',
          unitPrice: p.unit_price || 0,
          quantity: p.order_pro_count || 0,
          subtotal: sub,
        })
      }
      const dealerOrderTax = Math.round(dealerOrderSubtotal * 0.10)
      const dealerOrderTotal = dealerOrderSubtotal + dealerOrderTax  // 税込

      // 9. 最終精算額 = KB清算額 - 代理店注文額
      const netSettlement = grandTotal - dealerOrderTotal

      setCalcResult({
        entries,
        totalKickback: totalKb,
        totalSales,
        paperBagTotal,
        systemFee,
        kbOrderCount,
        paymentFee,
        creditCount: feeTargetOrderIds.size,
        creditSalesTotal: feeTargetSalesTotal,
        subtotalAfterDeductions,
        tax,
        grandTotal,
        dealerOrderSubtotal,
        dealerOrderTax,
        dealerOrderTotal,
        dealerOrderItems,
        dealerOrderCount: dealerOwnOrders.length,
        netSettlement,
        salonCount: entries.length,
        rowCount: products.length,
        orderCount: orders.length,
        kbRateLabel: (dealerKbRate != null && dealerKbRate !== '' && Number(dealerKbRate) > 0)
          ? `代理店原価率 ${Number(dealerKbRate)}%`
          : `グループ${dealerKbGroup}`,
      })
      setCalcSource('api')
      setApiProgress('')
    } catch (e) {
      alert('API取得エラー: ' + e.message)
      console.error(e)
    } finally {
      setApiFetching(false)
    }
  }

  // === CSVインポート処理 ===
  const handleCsvFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target.result
      const rows = parseCsvText(text)
      if (rows.length === 0) {
        alert('CSVデータを読み取れませんでした')
        return
      }

      // 代理店コード自動検出
      const code = rows[0]?.dealerCode
      if (code && !selectedCode) setSelectedCode(code)

      // 月を自動検出
      const firstDate = rows[0]?.orderedAt
      if (firstDate) {
        const match = firstDate.match(/(\d{4})-(\d{2})/)
        if (match) setMonth(`${match[1]}-${match[2]}`)
      }

      // サロン別に集計
      const salonMap = {}
      let paperBagTotal = 0

      for (const row of rows) {
        if (/紙袋/.test(row.productName)) {
          paperBagTotal += row.subtotal
          continue
        }
        const name = row.companyName || '（不明）'
        if (!salonMap[name]) {
          salonMap[name] = { orderDates: new Set(), total: 0, kb: 0 }
        }
        salonMap[name].orderDates.add(row.orderedAt?.split(' ')[0])
        salonMap[name].total += row.subtotal
        const is6plus1 = /6\+1|6＋1|キャンペーン/.test(row.productName)
        const rate = is6plus1 ? KB_RATE_CAMPAIGN : KB_RATE_STANDARD
        salonMap[name].kb += Math.round(row.subtotal * rate)
      }

      const entries = Object.entries(salonMap)
        .map(([name, data]) => ({
          salonName: name,
          type: 'sub',
          orderCount: data.orderDates.size,
          orderTotal: data.total,
          kickbackAmount: data.kb,
        }))
        .sort((a, b) => b.kickbackAmount - a.kickbackAmount)

      const totalKb = entries.reduce((s, e) => s + e.kickbackAmount, 0)
      const totalSales = entries.reduce((s, e) => s + e.orderTotal, 0)

      setCalcResult({
        entries,
        totalKickback: totalKb,
        totalSales,
        paperBagTotal,
        salonCount: entries.length,
        rowCount: rows.length,
      })
      setCalcSource('csv')
    }

    reader.readAsText(file, 'Shift_JIS')
    e.target.value = ''
  }

  // 計算結果を保存
  const handleSave = async () => {
    if (!calcResult || calcResult.entries.length === 0) return
    const code = selectedCode || ''
    if (!code) { alert('代理店コードを選択してください'); return }
    if (!confirm(`${month} のキックバック清算書を保存しますか？`)) return

    try {
      await addDoc(collection(db, 'kickbacks'), {
        dealerCode: code,
        dealerName: selectedDealer?.companyName || code,
        month,
        entries: calcResult.entries,
        totalKickback: calcResult.totalKickback,
        totalSales: calcResult.totalSales,
        paperBagTotal: calcResult.paperBagTotal || 0,
        systemFee: calcResult.systemFee || 0,
        kbOrderCount: calcResult.kbOrderCount || 0,
        paymentFee: calcResult.paymentFee || 0,
        creditCount: calcResult.creditCount || 0,
        subtotalAfterDeductions: calcResult.subtotalAfterDeductions || calcResult.totalKickback,
        tax: calcResult.tax || 0,
        grandTotal: calcResult.grandTotal || calcResult.totalKickback,
        dealerOrderSubtotal: calcResult.dealerOrderSubtotal || 0,
        dealerOrderTax: calcResult.dealerOrderTax || 0,
        dealerOrderTotal: calcResult.dealerOrderTotal || 0,
        dealerOrderCount: calcResult.dealerOrderCount || 0,
        dealerOrderItems: calcResult.dealerOrderItems || [],
        netSettlement: calcResult.netSettlement ?? (calcResult.grandTotal || calcResult.totalKickback),
        adjustments: adjustments.filter((a) => a.label && a.amount !== 0),
        adjustmentTotal: adjustments.reduce((s, a) => s + (a.amount || 0), 0),
        finalSettlement: (calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : calcResult.grandTotal) + adjustments.reduce((s, a) => s + (a.amount || 0), 0),
        stampDataUrl: stampDataUrl || null,
        companyInfo: companyInfo || null,
        bankInfo: selectedDealer?.bankInfo || null,
        source: calcSource === 'api' ? 'bcart-api' : 'csv-import',
        createdAt: serverTimestamp(),
      })

      const q = query(
        collection(db, 'kickbacks'),
        where('dealerCode', '==', code),
      )
      const snap = await getDocs(q)
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      docs.sort((a, b) => (b.month || '').localeCompare(a.month || ''))
      setStatements(docs)
      setCalcResult(null)
      setCalcSource(null)

      // パスワード付きPDF生成 → メール添付で自動送信
      try {
        const stmtForPdf = {
          ...calcResult,
          dealerCode: code,
          dealerName: selectedDealer?.companyName || code,
          month,
          companyInfo: companyInfo || null,
          stampDataUrl: stampDataUrl || null,
          bankInfo: selectedDealer?.bankInfo || null,
          adjustments: adjustments.filter((a) => a.label && a.amount !== 0),
          adjustmentTotal: adjustments.reduce((s, a) => s + (a.amount || 0), 0),
          finalSettlement: (calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : calcResult.grandTotal) + adjustments.reduce((s, a) => s + (a.amount || 0), 0),
        }
        const { base64, fileName, password } = await generateKickbackPdfBase64(stmtForPdf)

        const ccAddr = prompt('CC（自分で確認用、空欄可）:', '')
        const notifyFn = httpsCallable(functions, 'notifyKickback')
        const payload = {
          dealerCode: code,
          dealerName: selectedDealer?.companyName || code,
          month,
          grandTotal: calcResult.grandTotal || calcResult.totalKickback,
          pdfBase64: base64,
          pdfFileName: fileName,
        }
        if (ccAddr) payload.ccEmail = ccAddr
        const result = await notifyFn(payload)
        alert(`保存＆メール送信完了（${result.data.email}${ccAddr ? ` / CC: ${ccAddr}` : ''}）\nPDFパスワード: ${password}`)
      } catch (emailErr) {
        console.error('通知メール送信エラー:', emailErr)
        alert('保存しました（メール送信に失敗: ' + emailErr.message + '）')
      }
    } catch (e) {
      alert('保存に失敗しました: ' + e.message)
    }
  }

  // サロン紐付け追加
  const handleLink = async () => {
    const company = linkCompany.trim()
    if (!company || !selectedCode) return
    try {
      const ref = await addDoc(collection(db, 'dealerSalons'), {
        dealerCode: selectedCode,
        companyName: company,
        type: linkType,
        createdAt: serverTimestamp(),
      })
      setSalonLinks((prev) => [...prev, { id: ref.id, dealerCode: selectedCode, companyName: company, type: linkType }])
      setLinkCompany('')
    } catch (e) {
      alert('登録に失敗しました: ' + e.message)
    }
  }

  // サロン紐付け削除
  const handleUnlink = async (linkId) => {
    if (!confirm('この紐付けを解除しますか？')) return
    try {
      await deleteDoc(doc(db, 'dealerSalons', linkId))
      setSalonLinks((prev) => prev.filter((s) => s.id !== linkId))
    } catch (e) {
      alert('削除に失敗しました')
    }
  }

  // 過去の清算書を取得
  useEffect(() => {
    if (!selectedCode) {
      setStatements([])
      return
    }
    ;(async () => {
      try {
        const q = query(
          collection(db, 'kickbacks'),
          where('dealerCode', '==', selectedCode),
        )
        const snap = await getDocs(q)
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        docs.sort((a, b) => (b.month || '').localeCompare(a.month || ''))
        setStatements(docs)
      } catch (e) {
        console.error(e)
      }
    })()
  }, [selectedCode])

  const handleDeleteStmt = async (id) => {
    if (!confirm('この清算書を削除しますか？')) return
    try {
      await deleteDoc(doc(db, 'kickbacks', id))
      setStatements((prev) => prev.filter((s) => s.id !== id))
    } catch (e) {
      alert('削除に失敗しました')
    }
  }

  // 全代理店一括チェック
  const [bulkChecking, setBulkChecking] = useState(false)
  const [bulkResults, setBulkResults] = useState(null)

  const handleBulkCheck = async () => {
    if (!month) { alert('対象月を選択してください'); return }
    if (dealers.length === 0) { alert('代理店が登録されていません'); return }
    setBulkChecking(true)
    setBulkResults(null)
    try {
      // 月の全受注を1回だけ取得
      const allOrders = await fetchOrdersByMonth(month, () => {})
      const results = dealers.map((d) => {
        const code = d.dealerCode
        const matched = allOrders.filter((o) => String(o.customer_parent_id || '') === String(code))
        const salons = [...new Set(matched.map((o) => o.customer_comp_name || '（不明）'))]
        return {
          dealerCode: code,
          dealerName: d.companyName || code,
          orderCount: matched.length,
          salonCount: salons.length,
          salons,
          ok: matched.length > 0,
        }
      })
      setBulkResults(results)
    } catch (e) {
      alert('一括チェック失敗: ' + e.message)
    } finally {
      setBulkChecking(false)
    }
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  return (
    <div>
      <div className="mb-2 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">キックバック清算</h1>
        <button
          onClick={() => downloadKickbackFormula(kbSettings)}
          className="shrink-0 rounded-lg border border-indigo-300 bg-white px-4 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50"
          title="現在の設定値を反映した計算式の表をCSVでダウンロード"
        >
          計算式ダウンロード
        </button>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        BカートAPIから受注データを自動取得 → KB自動計算 → 保存 → PDFダウンロード
      </p>

      {/* 代理店・月選択 + 取得ボタン */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <select
          value={selectedCode}
          onChange={(e) => setSelectedCode(e.target.value)}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        >
          <option value="">代理店を選択...</option>
          {dealers.map((d) => (
            <option key={d.id} value={d.dealerCode}>
              {d.dealerCode} — {d.companyName}
            </option>
          ))}
        </select>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
        />
        <button
          onClick={handleApiFetch}
          disabled={apiFetching}
          className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {apiFetching ? '取得中...' : 'BカートAPI取得'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleCsvFile}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          CSV取込
        </button>
        <button
          onClick={handleBulkCheck}
          disabled={bulkChecking}
          className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
        >
          {bulkChecking ? 'チェック中...' : '🔍 全代理店チェック'}
        </button>
      </div>

      {/* 一括チェック結果 */}
      {bulkResults && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-800">
              全代理店 Bカート連動チェック（{month}）
              <span className="ml-2 text-xs font-normal text-gray-500">
                ✅ {bulkResults.filter((r) => r.ok).length}社連動 / ❌ {bulkResults.filter((r) => !r.ok).length}社未検出
              </span>
            </h3>
            <button onClick={() => setBulkResults(null)} className="text-xs text-gray-400 hover:text-gray-600">✕ 閉じる</button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="px-3 py-2">代理店コード</th>
                <th className="px-3 py-2">代理店名</th>
                <th className="px-3 py-2 text-center">状態</th>
                <th className="px-3 py-2 text-right">受注数</th>
                <th className="px-3 py-2 text-right">サロン数</th>
                <th className="px-3 py-2">所属サロン</th>
              </tr>
            </thead>
            <tbody>
              {bulkResults.map((r) => (
                <tr key={r.dealerCode} className={`border-b border-gray-50 ${r.ok ? '' : 'bg-red-50'}`}>
                  <td className="px-3 py-2 font-mono text-xs">{r.dealerCode}</td>
                  <td className="px-3 py-2 font-medium">{r.dealerName}</td>
                  <td className="px-3 py-2 text-center">{r.ok ? '✅' : '❌'}</td>
                  <td className="px-3 py-2 text-right">{r.orderCount}件</td>
                  <td className="px-3 py-2 text-right">{r.salonCount}社</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.salons.slice(0, 5).join('、')}{r.salons.length > 5 ? `…他${r.salons.length - 5}社` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* API進捗 */}
      {apiFetching && apiProgress && (
        <div className="mb-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">
          {apiProgress}
        </div>
      )}

      {/* 計算結果 */}
      {calcResult && (
        <div className={`mb-8 rounded-xl border-2 p-5 ${
          calcSource === 'api' ? 'border-indigo-300 bg-indigo-50' : 'border-green-300 bg-green-50'
        }`}>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {calcSource === 'api' ? 'API取得結果' : 'CSV取り込み結果'}
                （{calcResult.salonCount}サロン / {calcResult.rowCount}明細
                {calcResult.orderCount ? ` / ${calcResult.orderCount}受注` : ''}）
              </h2>
              <div className="mt-1 text-xs text-gray-500">
                売上合計: {fmtYen(calcResult.totalSales)}
                {calcResult.paperBagTotal > 0 && ` ／ 紙袋等除外: ${fmtYen(calcResult.paperBagTotal)}`}
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    const validAdj = adjustments.filter((a) => a.label && a.amount !== 0)
                    const adjTotal = validAdj.reduce((s, a) => s + (a.amount || 0), 0)
                    const base = calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : (calcResult.grandTotal || calcResult.totalKickback)
                    await generateKickbackPdf({
                      dealerCode: selectedCode || '',
                      dealerName: selectedDealer?.companyName || selectedCode || '',
                      month,
                      bankInfo: selectedDealer?.bankInfo || null,
                      stampDataUrl: stampDataUrl || null,
                      companyInfo: companyInfo || null,
                      ...calcResult,
                      adjustments: validAdj,
                      adjustmentTotal: adjTotal,
                      finalSettlement: base + adjTotal,
                    })
                  } catch (e) {
                    alert('PDF生成に失敗しました: ' + e.message)
                  }
                }}
                className="rounded-lg border border-indigo-300 bg-white px-4 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50"
              >
                PDFダウンロード
              </button>
              <button
                onClick={() => downloadKickbackCsv(calcResult, selectedCode || '', month, adjustments)}
                className="rounded-lg border border-green-300 bg-white px-4 py-2 text-sm font-bold text-green-700 hover:bg-green-50"
              >
                CSVダウンロード
              </button>
              <button
                onClick={handleSave}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-700"
              >
                保存してFirestoreに登録
              </button>
              <button
                onClick={() => { setCalcResult(null); setCalcSource(null) }}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                クリア
              </button>
            </div>
          </div>

          {/* 最終精算額ハイライト */}
          <div className="mb-4 rounded-xl bg-indigo-600 px-6 py-4 text-white">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-xs opacity-80">
                  {(calcResult.dealerOrderTotal > 0 || adjustments.some((a) => a.label && a.amount !== 0)) ? '最終精算額（税込）' : '差引総合計（税込）'}
                </div>
                <div className="text-3xl font-bold">
                  {fmtYen((() => {
                    const adj = adjustments.reduce((s, a) => s + ((a.label && a.amount !== 0) ? a.amount : 0), 0)
                    const base = calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : (calcResult.grandTotal || calcResult.totalKickback)
                    return (calcResult.dealerOrderTotal > 0 || adj !== 0) ? base + adj : base
                  })())}
                </div>
              </div>
              <div className="text-right text-sm opacity-80">
                <div>対象月: {month}</div>
                <div>代理店: {selectedCode || '—'}</div>
                {calcResult.kbRateLabel && <div>掛け率: {calcResult.kbRateLabel}</div>}
                <div className="mt-1">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${
                    calcSource === 'api' ? 'bg-indigo-500' : 'bg-green-500'
                  }`}>
                    {calcSource === 'api' ? 'BカートAPI' : 'CSV'}
                  </span>
                </div>
              </div>
            </div>
            {calcResult.grandTotal && (() => {
              const adjTotal = adjustments.reduce((s, a) => s + (a.amount || 0), 0)
              const baseAmount = calcResult.dealerOrderTotal > 0 ? calcResult.netSettlement : calcResult.grandTotal
              const finalAmount = baseAmount + adjTotal
              return (
              <div className="border-t border-indigo-400 pt-3 text-sm">
                <div className="grid grid-cols-2 gap-1">
                  <div className="opacity-80">KB金額合計</div>
                  <div className="text-right">{fmtYen(calcResult.totalKickback)}</div>
                  <div className="opacity-80">- システム利用料（{calcResult.kbOrderCount}件×¥300）</div>
                  <div className="text-right">-{fmtYen(calcResult.systemFee)}</div>
                  <div className="opacity-80">- 決済手数料 3%（{calcResult.creditCount}件分）</div>
                  <div className="text-right">-{fmtYen(calcResult.paymentFee)}</div>
                  <div className="mt-1 border-t border-indigo-400 pt-1 font-bold opacity-90">小計</div>
                  <div className="mt-1 border-t border-indigo-400 pt-1 text-right font-bold">{fmtYen(calcResult.subtotalAfterDeductions)}</div>
                  <div className="opacity-80">+ 消費税 10%</div>
                  <div className="text-right">{fmtYen(calcResult.tax)}</div>
                  <div className="mt-1 border-t border-indigo-400 pt-1 font-bold">KB清算額（税込）</div>
                  <div className="mt-1 border-t border-indigo-400 pt-1 text-right font-bold">{fmtYen(calcResult.grandTotal)}</div>
                  {calcResult.dealerOrderTotal > 0 && (
                    <>
                      <div className="mt-2 border-t border-indigo-300 pt-2 opacity-80">- 代理店注文額（税込・{calcResult.dealerOrderCount}件）</div>
                      <div className="mt-2 border-t border-indigo-300 pt-2 text-right">-{fmtYen(calcResult.dealerOrderTotal)}</div>
                    </>
                  )}
                  {/* 調整項目 */}
                  {adjustments.length > 0 && adjustments.map((adj, i) => (
                    <React.Fragment key={i}>
                      <div className="mt-1 opacity-80">{adj.amount >= 0 ? '+' : ''} {adj.label || '調整項目'}</div>
                      <div className="mt-1 text-right">{adj.amount >= 0 ? '+' : ''}{fmtYen(adj.amount)}</div>
                    </React.Fragment>
                  ))}
                  {(calcResult.dealerOrderTotal > 0 || adjustments.some((a) => a.label && a.amount !== 0)) && (
                    <>
                      <div className="mt-1 border-t-2 border-white pt-1 text-lg font-bold">最終精算額</div>
                      <div className="mt-1 border-t-2 border-white pt-1 text-right text-lg font-bold">{fmtYen(finalAmount)}</div>
                    </>
                  )}
                </div>
              </div>
              )})()}

            {/* 調整項目の追加・編集 */}
            {calcResult && (
              <div className="mt-3 rounded-lg border border-indigo-300 bg-indigo-50 p-3">
                <div className="mb-2 text-xs font-bold text-indigo-700">調整項目</div>
                {adjustments.map((adj, i) => (
                  <div key={i} className="mb-1 flex items-center gap-2">
                    <span className="text-[10px] text-gray-400">{adj.fixed ? '固定' : '都度'}</span>
                    <input
                      type="text"
                      value={adj.label}
                      onChange={(e) => {
                        const items = [...adjustments]
                        items[i] = { ...items[i], label: e.target.value }
                        setAdjustments(items)
                      }}
                      className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
                      placeholder="項目名"
                    />
                    <input
                      type="number"
                      value={adj.amount}
                      onChange={(e) => {
                        const items = [...adjustments]
                        items[i] = { ...items[i], amount: Number(e.target.value) }
                        setAdjustments(items)
                      }}
                      className="w-28 rounded border border-gray-300 px-2 py-1 text-xs text-right focus:border-indigo-500 focus:outline-none"
                    />
                    <span className="text-[10px] text-gray-400">円</span>
                    <button
                      onClick={() => setAdjustments(adjustments.filter((_, idx) => idx !== i))}
                      className="text-xs text-red-400 hover:text-red-600"
                    >✕</button>
                  </div>
                ))}
                <button
                  onClick={() => setAdjustments([...adjustments, { label: '', amount: 0, fixed: false }])}
                  className="mt-1 rounded border border-dashed border-indigo-300 px-2 py-1 text-[10px] text-indigo-500 hover:bg-indigo-100"
                >
                  ＋ 調整項目を追加
                </button>
              </div>
            )}
          </div>

          {/* 代理店自身の注文明細 */}
          {calcResult.dealerOrderItems?.length > 0 && (
            <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-4">
              <h3 className="mb-2 font-bold text-orange-800">代理店自身の注文（{calcResult.dealerOrderCount}件）</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-orange-200 text-left text-xs text-orange-600">
                    <th className="px-2 py-1">注文日</th>
                    <th className="px-2 py-1">商品名</th>
                    <th className="px-2 py-1">セット名</th>
                    <th className="px-2 py-1 text-right">数量</th>
                    <th className="px-2 py-1 text-right">単価</th>
                    <th className="px-2 py-1 text-right">小計</th>
                  </tr>
                </thead>
                <tbody>
                  {calcResult.dealerOrderItems.map((item, i) => (
                    <tr key={i} className="border-b border-orange-100">
                      <td className="px-2 py-1 text-xs">{item.date}</td>
                      <td className="px-2 py-1 text-xs">{item.productName}</td>
                      <td className="px-2 py-1 text-xs">{item.setName}</td>
                      <td className="px-2 py-1 text-right">{item.quantity}</td>
                      <td className="px-2 py-1 text-right">{fmtYen(item.unitPrice)}</td>
                      <td className="px-2 py-1 text-right">{fmtYen(item.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-orange-300 font-bold text-orange-800">
                    <td colSpan={5} className="px-2 py-1">小計（税抜）</td>
                    <td className="px-2 py-1 text-right">{fmtYen(calcResult.dealerOrderSubtotal)}</td>
                  </tr>
                  <tr className="text-orange-700">
                    <td colSpan={5} className="px-2 py-1">消費税 10%</td>
                    <td className="px-2 py-1 text-right">{fmtYen(calcResult.dealerOrderTax)}</td>
                  </tr>
                  <tr className="border-t border-orange-300 font-bold text-orange-800">
                    <td colSpan={5} className="px-2 py-1">合計（税込）</td>
                    <td className="px-2 py-1 text-right">{fmtYen(calcResult.dealerOrderTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* サロン別テーブル */}
          <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
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
                {calcResult.entries.map((e, i) => {
                  const isExpanded = expandedSalons.has(e.salonName)
                  return (
                    <React.Fragment key={i}>
                      <tr
                        className="cursor-pointer border-b border-gray-50 hover:bg-gray-50"
                        onClick={() => setExpandedSalons((prev) => {
                          const next = new Set(prev)
                          if (next.has(e.salonName)) next.delete(e.salonName)
                          else next.add(e.salonName)
                          return next
                        })}
                      >
                        <td className="px-4 py-2 text-xs text-gray-400">
                          <span className="mr-1">{isExpanded ? '▼' : '▶'}</span>{i + 1}
                        </td>
                        <td className="px-4 py-2 font-medium text-gray-900">{e.salonName}</td>
                        <td className="px-4 py-2 text-right">{e.orderCount}回</td>
                        <td className="px-4 py-2 text-right">{fmtYen(e.orderTotal)}</td>
                        <td className="px-4 py-2 text-right font-bold text-indigo-600">{fmtYen(e.kickbackAmount)}</td>
                      </tr>
                      {isExpanded && e.orders && e.orders.map((ord, oi) => (
                        <React.Fragment key={`${i}-o${oi}`}>
                          <tr className="border-b border-gray-100 bg-indigo-50/40">
                            <td className="px-4 py-1.5"></td>
                            <td className="px-4 py-1.5 text-xs font-bold text-gray-700">
                              {ord.date}
                              <span className="ml-2 font-normal text-gray-400">{ord.payment}</span>
                            </td>
                            <td className="px-4 py-1.5 text-right text-xs text-gray-500">{ord.items.length}品</td>
                            <td className="px-4 py-1.5 text-right text-xs font-medium text-gray-700">{fmtYen(ord.total)}</td>
                            <td className="px-4 py-1.5 text-right text-xs font-medium text-indigo-600">{fmtYen(ord.kb)}</td>
                          </tr>
                          {ord.items.map((item, j) => (
                            <tr key={`${i}-o${oi}-${j}`} className="border-b border-gray-50 bg-gray-50/30">
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
                    </React.Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-indigo-200 bg-indigo-50">
                  <td className="px-4 py-3 font-bold" colSpan={3}>合計（{calcResult.salonCount}サロン）</td>
                  <td className="px-4 py-3 text-right font-bold">{fmtYen(calcResult.totalSales)}</td>
                  <td className="px-4 py-3 text-right text-lg font-bold text-indigo-600">{fmtYen(calcResult.totalKickback)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {selectedCode && (
        <div>
          {/* 保存済み清算書 */}
          <div>
            {statements.length > 0 ? (
              <div>
                <h3 className="mb-3 text-sm font-bold text-gray-700">保存済み清算書</h3>
                {statements.map((stmt) => (
                  <div key={stmt.id} className="mb-3 rounded-xl border border-gray-200 bg-white">
                    <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                      <div>
                        <span className="font-bold text-gray-900">{stmt.month}</span>
                        <span className="ml-4 text-lg font-bold text-indigo-600">
                          {fmtYen(stmt.totalKickback)}
                        </span>
                        {stmt.source && (
                          <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                            stmt.source === 'bcart-api'
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {stmt.source === 'bcart-api' ? 'API' : 'CSV'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={async () => {
                            try {
                              await generateKickbackPdf({ ...stmt, stampDataUrl: stampDataUrl || null, companyInfo: companyInfo || null })
                            } catch (e) {
                              alert('PDF生成に失敗しました: ' + e.message)
                            }
                          }}
                          className="rounded border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                        >
                          PDF
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              const dealer = dealers.find((d) => d.dealerCode === stmt.dealerCode)
                              const defaultTo = dealer?.email || ''
                              const to = prompt('宛先メールアドレス:', defaultTo)
                              if (!to) return
                              const cc = 'takayama1970817@gmail.com'

                              const stmtForPdf = { ...stmt, stampDataUrl: stampDataUrl || null, companyInfo: companyInfo || null }
                              const { base64, fileName } = await generateKickbackPdfBase64(stmtForPdf)

                              const dealerName = stmt.dealerName || dealer?.companyName || stmt.dealerCode
                              const monthLabel = (stmt.month || '').replace('-', '年') + '月'
                              const grandTotal = stmt.grandTotal || stmt.totalKickback || 0
                              const yen = '¥' + Number(grandTotal).toLocaleString()

                              const companyName = companyInfo?.name || 'ロイヤルトラスト株式会社'
                              const senderName = companyInfo?.name || 'ロイヤルトラスト株式会社'
                              const senderEmail = companyInfo?.email || 'inv@royaltrust.jp'

                              const subject = `【${companyName}】${monthLabel} 清算書のご送付`
                              const body =
`${dealerName} 御中

いつもお世話になっております。
${companyName}です。

${monthLabel}分の清算書をお送りいたします。
ご確認のほどよろしくお願いいたします。

■ 清算金額： ${yen}（税込）
■ 添付ファイル： ${fileName}

ご不明点がございましたら、本メールへご返信ください。

--
${senderName}
${senderEmail}
`
                              downloadEml({
                                from: `${senderName} <${senderEmail}>`,
                                to,
                                cc,
                                subject,
                                body,
                                pdfBase64: base64,
                                pdfFileName: fileName,
                                emlFileName: `KB清算_${stmt.dealerCode}_${(stmt.month || '').replace('-', '')}.eml`,
                              })
                              alert(
                                'PDFをダウンロードし、Gmail作成画面を新しいタブで開きました。\n\n' +
                                '【手順】\n' +
                                '1. ダウンロードフォルダのPDFを Gmail 作成画面にドラッグ＆ドロップ\n' +
                                '2. 内容を確認して「送信」ボタンを押す\n\n' +
                                '※ ポップアップがブロックされた場合は、アドレスバー右のアイコンから許可してください。',
                              )
                            } catch (e) {
                              alert('メール下書き生成に失敗: ' + e.message)
                            }
                          }}
                          className="rounded border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                        >
                          📧Gmail下書き
                        </button>
                        <button
                          onClick={async () => {
                            const testAddr = prompt('テスト送信先メールアドレス:', 'takayama1970817@gmail.com')
                            if (!testAddr) return
                            try {
                              const stmtForPdf = { ...stmt, stampDataUrl: stampDataUrl || null, companyInfo: companyInfo || null }
                              const { base64, fileName } = await generateKickbackPdfBase64(stmtForPdf)

                              const dealer = dealers.find((d) => d.dealerCode === stmt.dealerCode)
                              const dealerName = stmt.dealerName || dealer?.companyName || stmt.dealerCode
                              const monthLabel = (stmt.month || '').replace('-', '年') + '月'
                              const grandTotal = stmt.grandTotal || stmt.totalKickback || 0
                              const yen = '¥' + Number(grandTotal).toLocaleString()
                              const companyName = companyInfo?.name || 'ロイヤルトラスト株式会社'
                              const senderEmail = companyInfo?.email || 'inv@royaltrust.jp'

                              const subject = `【テスト】【${companyName}】${monthLabel} 清算書のご送付`
                              const body =
`※これはテスト送信です。本番宛先: ${dealer?.email || '（未登録）'}

${dealerName} 御中

いつもお世話になっております。
${companyName}です。

${monthLabel}分の清算書をお送りいたします。
ご確認のほどよろしくお願いいたします。

■ 清算金額： ${yen}（税込）
■ 添付ファイル： ${fileName}

ご不明点がございましたら、本メールへご返信ください。

--
${companyName}
${senderEmail}
`
                              downloadEml({
                                from: `${companyName} <${senderEmail}>`,
                                to: testAddr,
                                subject,
                                body,
                                pdfBase64: base64,
                                pdfFileName: fileName,
                                emlFileName: `KB清算_TEST_${stmt.dealerCode}_${(stmt.month || '').replace('-', '')}.eml`,
                              })
                              alert(
                                `テスト用Gmail作成画面を開きました（宛先: ${testAddr}）\n\n` +
                                '【手順】\n' +
                                '1. ダウンロードフォルダのPDFを Gmail 作成画面にドラッグ＆ドロップ\n' +
                                '2. 「送信」ボタンを押す',
                              )
                            } catch (e) {
                              alert('テスト下書き生成失敗: ' + e.message)
                            }
                          }}
                          className="rounded border border-green-300 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
                        >
                          🧪テスト
                        </button>
                        <button
                          onClick={() => handleDeleteStmt(stmt.id)}
                          className="text-xs text-red-500 hover:underline"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                    <div className="px-4 py-2">
                      {stmt.entries?.map((e, i) => (
                        <div key={i} className="flex items-center justify-between border-b border-gray-50 py-1.5 text-sm">
                          <div>
                            <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                              e.type === 'own' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                            }`}>
                              {e.type === 'own' ? '自社' : '所属'}
                            </span>
                            {e.salonName}
                            <span className="ml-2 text-xs text-gray-400">{e.orderCount}件</span>
                          </div>
                          <span className="font-medium">{fmtYen(e.kickbackAmount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
                「BカートAPI取得」ボタンでKB清算書を自動作成できます
              </div>
            )}
          </div>
        </div>
      )}

      {!selectedCode && !calcResult && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-400">
          対象月を選択して「BカートAPI取得」をクリック、または代理店を選択してください
        </div>
      )}
    </div>
  )
}
