/**
 * 代理店ダッシュボード用 日次スナップショット集計スクリプト
 *   dealerMonthlySnapshots/{dealerCode}_{YYYY-MM} を作成・更新する。
 *
 * 設計の柱（/dealer/dashboard-exec との整合 2026-04-19 確定）:
 *   - 所属サロン: Bカート 会員API (parent_id == dealerCode) を source of truth
 *   - 月売上 / 前月同日比: Bカート 受注 (customer_parent_id == dealerCode, final_price 税込)
 *   - 判定カットオフ: snapshotCutoffAt（当日 12:00、または MONTH 指定時は月末）
 *   - Firestore dealerSalons は meta 情報（type='own'/'sub'、createdAt）としてのみ使用
 *   - Firestore orders は二次情報で、集計主体には用いない（/dealer/dashboard-exec と齟齬が出るため）
 *
 * 書き込むスキーマ:
 *   dealerMonthlySnapshots/{dealerCode}_{YYYY-MM}
 *     dealerCode, month,
 *     monthRevenue, prevMonthSameDayRevenue,
 *     activeSalonCount, totalSalonCount, operationRate,
 *     kickbackEstimate,
 *     salonsStale30/14/new, followPriorityTop10,
 *     recentOrders,
 *     snapshotAt, snapshotCutoffAt, createdAt, updatedAt
 *
 * 使用方法:
 *   node scripts/aggregate-dealer-monthly.mjs                                    # dry-run 全件
 *   DEALER_CODE=J0002 node scripts/aggregate-dealer-monthly.mjs                  # 1社 dry-run
 *   DRY_RUN=false OPERATOR="社長 ボンバー" node scripts/aggregate-dealer-monthly.mjs
 *   MONTH=2026-03 DRY_RUN=false node scripts/aggregate-dealer-monthly.mjs        # 過去月再集計
 *   VERBOSE=true node scripts/aggregate-dealer-monthly.mjs                       # Top10 を JSON ダンプ
 *
 * 必要な環境変数（.env.local）:
 *   VITE_BCART_API_TOKEN  — Bカート API トークン（_env.mjs 経由）
 *
 * 必要ファイル:
 *   scripts/service-account.json — Firebase Admin SDK 秘密鍵
 */
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken, loadAdminCredential } from './_env.mjs'

// scripts ディレクトリ絶対パス（_env.mjs に渡す）
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

// 本番 projectId 検証付きで service account を読み込み
// （test 用 credential で本番想定スクリプトが動く事故を防ぐ）
const { serviceAccount, projectId, credentialPath } = loadAdminCredential(SCRIPTS_DIR)
console.log(`📌 Firebase: ${projectId} (${credentialPath})`)

initializeApp({
  credential: cert(serviceAccount),
  projectId,
})
const db = getFirestore()

const BCART_TOKEN = getBcartToken()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const DEALER_CODE_FILTER = process.env.DEALER_CODE || null
const MONTH_OVERRIDE = process.env.MONTH || null
const ORDER_WINDOW_MONTHS = Number(process.env.ORDER_WINDOW_MONTHS) || 13

const MAX_LIST = 5
const BCART_PAGE = 100

// ========================================
// Bカート API helpers
// scripts/bcart-sync.mjs と同一のレート制限対応パターン
// ========================================
async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  for (let retry = 0; retry < 5; retry++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${BCART_TOKEN}` },
    })
    if (res.status === 429) {
      const wait = (retry + 1) * 3000
      console.log(`   ⏳ レート制限 → ${wait / 1000}秒待機...`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new Error(`Bカート API error: ${res.status} ${res.statusText}`)
    return res.json()
  }
  throw new Error('Bカート レート制限が継続中。時間をおいて再実行してください。')
}

async function fetchAllBcartCustomers() {
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('customers', { limit: BCART_PAGE, offset })
    const items = data.customers || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    process.stdout.write(`\r  Bカート 会員: ${all.length}/${total} 件`)
    if (all.length >= total) break
    offset += BCART_PAGE
  }
  process.stdout.write('\n')
  return all
}

async function fetchBcartOrdersForMonth(ym) {
  const [yy, mm] = ym.split('-')
  const lastDay = new Date(Number(yy), Number(mm), 0).getDate()
  const from = `${yy}-${mm}-01 00:00:00`
  const to = `${yy}-${mm}-${String(lastDay).padStart(2, '0')} 23:59:59`
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('orders', {
      limit: BCART_PAGE,
      offset,
      ordered_at__gte: from,
      ordered_at__lte: to,
    })
    const items = data.orders || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    if (all.length >= total) break
    offset += BCART_PAGE
  }
  return all
}

function generateMonthList(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number)
  const [ty, tm] = toYM.split('-').map(Number)
  const out = []
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

// ========================================
// 時間窓
// ========================================
function toYearMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function resolveTimeWindows() {
  const now = new Date()
  let month
  let cutoff
  if (MONTH_OVERRIDE) {
    const m = MONTH_OVERRIDE.match(/^(\d{4})-(\d{2})$/)
    if (!m) throw new Error(`MONTH は YYYY-MM 形式で指定してください: ${MONTH_OVERRIDE}`)
    const y = Number(m[1])
    const mm = Number(m[2])
    month = `${y}-${String(mm).padStart(2, '0')}`
    cutoff = new Date(y, mm, 0, 23, 59, 59, 999)
  } else {
    month = toYearMonth(now)
    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  }

  const [y, mm] = month.split('-').map(Number)
  const thisMonthStart = new Date(y, mm - 1, 1, 0, 0, 0, 0)
  const prevMonthStart = new Date(y, mm - 2, 1, 0, 0, 0, 0)
  const prevMonthSameDay = new Date(
    cutoff.getFullYear(),
    cutoff.getMonth() - 1,
    cutoff.getDate(),
    cutoff.getHours(),
    cutoff.getMinutes(),
    cutoff.getSeconds(),
    cutoff.getMilliseconds(),
  )

  // Bcart 受注取得窓: カットオフから ORDER_WINDOW_MONTHS か月前まで
  const fetchStart = new Date(cutoff)
  fetchStart.setMonth(fetchStart.getMonth() - (ORDER_WINDOW_MONTHS - 1))
  fetchStart.setDate(1)

  return {
    month,
    cutoff,
    thisMonthStart,
    prevMonthStart,
    prevMonthSameDay,
    fetchStartYM: toYearMonth(fetchStart),
    fetchEndYM: toYearMonth(cutoff),
  }
}

function tsToDate(ts) {
  if (!ts) return null
  if (typeof ts.toDate === 'function') return ts.toDate()
  if (ts instanceof Date) return ts
  return new Date(ts)
}

function parseBcartDate(raw) {
  if (!raw) return null
  // 'YYYY-MM-DD HH:MM:SS' → ISO
  const d = new Date(String(raw).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

function parentIdOf(rec) {
  return String(rec?.parent_id ?? rec?.customer_parent_id ?? rec?.parent_member_id ?? '').trim()
}

function companyNameOf(rec) {
  return (rec?.comp_name || rec?.customer_comp_name || rec?.name || rec?.customer_name || '').trim()
}

// ========================================
// Firestore
// ========================================
async function fetchDealers() {
  const snap = await db.collection('allowedEmails').where('role', '==', 'dealer').get()
  const out = []
  snap.forEach((d) => {
    const data = d.data()
    if (!data.dealerCode) return
    if (DEALER_CODE_FILTER && String(data.dealerCode) !== String(DEALER_CODE_FILTER)) return
    out.push({
      id: d.id,
      dealerCode: String(data.dealerCode),
      companyName: data.companyName || '',
      kbRate: Number(data.kbRate) || 0,
    })
  })
  return out
}

async function fetchDealerSalonsMeta(dealerCode) {
  const snap = await db.collection('dealerSalons').where('dealerCode', '==', dealerCode).get()
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// ========================================
// 集計
// ========================================
function aggregateForDealer({ dealer, dealerSalonsMeta, bcartMembers, bcartOrdersRaw, windows }) {
  const { month, cutoff, thisMonthStart, prevMonthStart, prevMonthSameDay } = windows

  // Bcart 受注を正規化 + cutoff でフィルタ
  const orders = bcartOrdersRaw
    .map((o) => ({
      id: String(o.id || o.code || ''),
      companyName: companyNameOf(o) || '（不明）',
      total: Number(o.final_price ?? o.total_price) || 0,
      orderDate: parseBcartDate(o.ordered_at),
      orderNumber: String(o.order_no || o.order_number || o.code || ''),
    }))
    .filter((o) => o.orderDate && o.orderDate <= cutoff)

  // 月売上（税込）
  let monthRevenue = 0
  for (const o of orders) {
    if (o.orderDate >= thisMonthStart && o.orderDate <= cutoff) monthRevenue += o.total
  }

  // 前月同日比
  let prevMonthSameDayRevenue = 0
  for (const o of orders) {
    if (o.orderDate >= prevMonthStart && o.orderDate <= prevMonthSameDay) {
      prevMonthSameDayRevenue += o.total
    }
  }

  // サロン別 first/last
  const ordersByCompany = new Map()
  for (const o of orders) {
    if (!o.companyName) continue
    const prev = ordersByCompany.get(o.companyName)
    if (!prev) ordersByCompany.set(o.companyName, { first: o.orderDate, last: o.orderDate })
    else {
      if (o.orderDate < prev.first) prev.first = o.orderDate
      if (o.orderDate > prev.last) prev.last = o.orderDate
    }
  }

  // Bcart 会員 = 所属サロンの source of truth（/dealer/dashboard-exec と同じ）
  const memberNames = new Set()
  for (const c of bcartMembers) {
    const n = companyNameOf(c)
    if (n) memberNames.add(n)
  }

  // dealerSalons (Firestore) はメタ情報として付与
  const dealerSalonByName = new Map()
  for (const s of dealerSalonsMeta) {
    if (s.companyName) dealerSalonByName.set(s.companyName, s)
  }

  // 所属サロン union（Bcart会員 + Bcart受注から検出 + dealerSalons）
  const allNames = new Set([
    ...memberNames,
    ...ordersByCompany.keys(),
    ...dealerSalonByName.keys(),
  ])

  const dayMs = 24 * 60 * 60 * 1000
  const thirtyDaysAgo = new Date(cutoff.getTime() - 30 * dayMs)
  const fourteenDaysAgo = new Date(cutoff.getTime() - 14 * dayMs)

  let activeSalonCount = 0
  const salonsStale30 = []
  const salonsStale14 = []
  const salonsNew = []
  const prioritized = []

  for (const name of allNames) {
    const meta = dealerSalonByName.get(name) || null
    const ord = ordersByCompany.get(name) || null
    const salonKey = meta?.id || `auto-${name}`
    const firstOrder = ord?.first || null
    const lastOrder = ord?.last || null
    const createdAt = tsToDate(meta?.createdAt)

    if (lastOrder && lastOrder >= thirtyDaysAgo) activeSalonCount += 1

    let status
    let nextAction
    let priority
    let daysSinceLast = null

    // 優先度設計（行動優先度、高いほど Top10 の上位に表示）
    //   stale30 > stale14 > new(first order) > new(just linked) > no-order(長期眠り)
    //   no-order を最下位に置くことで、実際にフォローすべき既存顧客を前面に出す。
    //   （no-order が大量にあっても、stale30/14/new がある分はそちらを優先表示）
    if (!lastOrder) {
      if (createdAt && createdAt >= thirtyDaysAgo) {
        status = 'new'
        nextAction = '紐付け直後 → 初回コール'
        priority = 5000 // new-just-linked: 新規リードとして中位
        salonsNew.push({
          salonKey,
          name,
          firstOrderDate: null,
          _sortKey: createdAt.getTime(),
        })
      } else {
        status = 'no-order'
        nextAction = '発注なし → ヒアリング'
        priority = 100 // 長期眠り: バックログ扱い（最下位）
        salonsStale30.push({ salonKey, name, lastOrderDate: null, _sortKey: 0 })
      }
    } else {
      daysSinceLast = Math.floor((cutoff.getTime() - lastOrder.getTime()) / dayMs)
      const isNewByOrder = firstOrder >= thirtyDaysAgo
      if (isNewByOrder) {
        status = 'new'
        nextAction = '初回発注 → 御礼＋次回提案'
        priority = 10000 // momentum 醸成のため中〜上位
        salonsNew.push({
          salonKey,
          name,
          firstOrderDate: Timestamp.fromDate(firstOrder),
          _sortKey: firstOrder.getTime(),
        })
      } else if (lastOrder < thirtyDaysAgo) {
        status = 'stale30'
        nextAction = '30日以上未発注 → 電話フォロー'
        priority = 50000 + daysSinceLast // 最優先: 失注しかけの既知客
        salonsStale30.push({
          salonKey,
          name,
          lastOrderDate: Timestamp.fromDate(lastOrder),
          _sortKey: lastOrder.getTime(),
        })
      } else if (lastOrder < fourteenDaysAgo) {
        status = 'stale14'
        nextAction = '14日以上未発注 → リマインド'
        priority = 20000 + daysSinceLast // 早期アラート
        salonsStale14.push({
          salonKey,
          name,
          lastOrderDate: Timestamp.fromDate(lastOrder),
          _sortKey: lastOrder.getTime(),
        })
      } else {
        // 直近14日以内に発注あり → フォロー不要
        continue
      }
    }

    prioritized.push({
      salonKey,
      name,
      status,
      nextAction,
      lastOrderDate: lastOrder ? Timestamp.fromDate(lastOrder) : null,
      firstOrderDate: firstOrder ? Timestamp.fromDate(firstOrder) : null,
      daysSinceLast,
      _priority: priority,
    })
  }

  const totalSalonCount = allNames.size
  const operationRate = totalSalonCount > 0 ? activeSalonCount / totalSalonCount : 0

  const followPriorityTop10 = prioritized
    .sort((a, b) => b._priority - a._priority)
    .slice(0, 10)
    .map(({ _priority, ...rest }) => rest)

  const trimStale = (arr) =>
    arr
      .sort((a, b) => a._sortKey - b._sortKey)
      .slice(0, MAX_LIST)
      .map(({ _sortKey, ...rest }) => rest)
  const trimNew = (arr) =>
    arr
      .sort((a, b) => b._sortKey - a._sortKey)
      .slice(0, MAX_LIST)
      .map(({ _sortKey, ...rest }) => rest)

  const recentOrders = orders
    .sort((a, b) => b.orderDate - a.orderDate)
    .slice(0, MAX_LIST)
    .map((o) => ({
      orderId: o.id,
      orderDate: Timestamp.fromDate(o.orderDate),
      salonName: o.companyName,
      totalAmount: o.total,
    }))

  const kickbackEstimate = Math.round(monthRevenue * (dealer.kbRate || 0) / 100)

  return {
    snapshot: {
      dealerCode: dealer.dealerCode,
      month,
      monthRevenue: Math.round(monthRevenue),
      prevMonthSameDayRevenue: Math.round(prevMonthSameDayRevenue),
      activeSalonCount,
      totalSalonCount,
      operationRate: Math.round(operationRate * 1000) / 1000,
      kickbackEstimate,
      salonsStale30: trimStale(salonsStale30),
      salonsStale14: trimStale(salonsStale14),
      salonsNew: trimNew(salonsNew),
      followPriorityTop10,
      recentOrders,
      snapshotCutoffAt: Timestamp.fromDate(cutoff),
    },
    sourceBreakdown: {
      bcartMemberCount: memberNames.size,
      bcartOrderDerivedCount: [...ordersByCompany.keys()].filter((n) => !memberNames.has(n)).length,
      dealerSalonsMetaCount: dealerSalonByName.size,
      bcartOrderTotal: orders.length,
    },
  }
}

// ========================================
// main
// ========================================
async function main() {
  console.log('=== dealerMonthlySnapshots 集計 (Bカート baseline) ===')
  const windows = resolveTimeWindows()
  console.log(`モード       : ${DRY_RUN ? '🟡 DRY RUN' : '🔴 本番実行'}`)
  console.log(`OPERATOR     : ${OPERATOR}`)
  console.log(`集計月       : ${windows.month}`)
  console.log(`カットオフ   : ${windows.cutoff.toISOString()}`)
  console.log(`Bcart 受注窓 : ${windows.fetchStartYM} 〜 ${windows.fetchEndYM}`)
  if (DEALER_CODE_FILTER) console.log(`対象代理店   : ${DEALER_CODE_FILTER} のみ`)
  console.log('')

  const dealers = await fetchDealers()
  console.log(`代理店 ${dealers.length} 社`)
  console.log('')

  console.log('▶ Bカート 会員一覧取得...')
  const allCustomers = await fetchAllBcartCustomers()
  console.log(`  総会員数: ${allCustomers.length} 件`)
  const customersByParent = new Map()
  // 注文の帰属解決用: customer_id → current parent_id （会員マスタの現在値が source of truth）
  //   V→J の代理店コード変更のように会員マスタが更新されても、
  //   注文時点の customer_parent_id では解決できない問題を回避する。
  const parentByCustomerId = new Map()
  for (const c of allCustomers) {
    const parent = parentIdOf(c)
    const cid = String(c.id ?? '')
    if (cid) parentByCustomerId.set(cid, parent)
    if (!parent) continue
    if (!customersByParent.has(parent)) customersByParent.set(parent, [])
    customersByParent.get(parent).push(c)
  }
  console.log('')

  console.log(`▶ Bカート 受注取得（${windows.fetchStartYM} 〜 ${windows.fetchEndYM}）...`)
  const months = generateMonthList(windows.fetchStartYM, windows.fetchEndYM)
  const allOrdersRaw = []
  for (const ym of months) {
    const list = await fetchBcartOrdersForMonth(ym)
    console.log(`  ${ym}: ${list.length} 件`)
    allOrdersRaw.push(...list)
  }
  // 帰属解決ロジック:
  //   1st: customer_id → parentByCustomerId（会員マスタの現在値・推奨）
  //   2nd: 注文の captured parent_id（会員マスタで解決できなかった時のフォールバック）
  //   カウンタで両経路の件数を可視化し、乖離が増えたら通知できるようにする。
  const ordersByParent = new Map()
  let resolvedByMember = 0
  let resolvedByCaptured = 0
  let resolvedUnchanged = 0
  let diffFromCaptured = 0
  for (const o of allOrdersRaw) {
    const captured = parentIdOf(o)
    const cid = String(o.customer_id ?? '')
    const fromMember = cid ? parentByCustomerId.get(cid) : null
    const resolved = fromMember || captured
    if (!resolved) continue
    if (fromMember) {
      resolvedByMember += 1
      if (captured && captured !== fromMember) diffFromCaptured += 1
      else resolvedUnchanged += 1
    } else {
      resolvedByCaptured += 1
    }
    if (!ordersByParent.has(resolved)) ordersByParent.set(resolved, [])
    ordersByParent.get(resolved).push(o)
  }
  const ordersWithParent = [...ordersByParent.values()].reduce((s, a) => s + a.length, 0)
  console.log(
    `  合計: ${allOrdersRaw.length} 件（帰属解決: ${ordersWithParent} 件 / ` +
      `会員マスタ経由 ${resolvedByMember} / captured fallback ${resolvedByCaptured}）`,
  )
  if (diffFromCaptured > 0) {
    console.log(
      `  ℹ️  ${diffFromCaptured} 件は注文の captured parent_id と会員マスタの現在値が不一致（会員マスタ優先で解決済み）`,
    )
  }
  console.log('')

  const results = []
  const errors = []

  for (const dealer of dealers) {
    try {
      const dealerSalonsMeta = await fetchDealerSalonsMeta(dealer.dealerCode)
      const bcartMembers = customersByParent.get(dealer.dealerCode) || []
      const bcartOrdersRaw = ordersByParent.get(dealer.dealerCode) || []

      const { snapshot, sourceBreakdown } = aggregateForDealer({
        dealer,
        dealerSalonsMeta,
        bcartMembers,
        bcartOrdersRaw,
        windows,
      })
      results.push({ dealer, snapshot })

      const kbHint = dealer.kbRate > 0 ? '' : ' ⚠️ kbRate 未設定'
      console.log(
        `  ✅ ${dealer.dealerCode} ${dealer.companyName || ''} ` +
          `月売上 ¥${snapshot.monthRevenue.toLocaleString()} / ` +
          `前月同日 ¥${snapshot.prevMonthSameDayRevenue.toLocaleString()} / ` +
          `稼働 ${snapshot.activeSalonCount}/${snapshot.totalSalonCount} ` +
          `(Bcart会員 ${sourceBreakdown.bcartMemberCount} + 受注由来 ${sourceBreakdown.bcartOrderDerivedCount} + dealerSalons ${sourceBreakdown.dealerSalonsMetaCount}) / ` +
          `見込KB ¥${snapshot.kickbackEstimate.toLocaleString()}${kbHint}`,
      )
      const top = snapshot.followPriorityTop10 || []
      console.log(`     followPriorityTop10: ${top.length}件`)
      top.slice(0, 3).forEach((s, i) => {
        console.log(`       ${i + 1}. ${s.name || '(名前なし)'} / ${s.status} / ${s.nextAction}`)
      })
      if (process.env.VERBOSE === 'true' && top.length > 0) {
        const jsonReady = top.map((s) => ({
          ...s,
          lastOrderDate: s.lastOrderDate?.toDate?.().toISOString() || null,
          firstOrderDate: s.firstOrderDate?.toDate?.().toISOString() || null,
        }))
        console.log('     followPriorityTop10 (full JSON):')
        console.log(JSON.stringify(jsonReady, null, 2).replace(/^/gm, '     '))
      }
    } catch (e) {
      errors.push({ dealerCode: dealer.dealerCode, message: e.message })
      console.error(`  ❌ ${dealer.dealerCode}: ${e.message}`)
    }
  }

  console.log('')
  if (DRY_RUN) {
    console.log(`🟡 DRY RUN のため書き込みはしていません（${results.length} 件を算出）`)
    console.log('   本番実行: DRY_RUN=false OPERATOR="名前" node scripts/aggregate-dealer-monthly.mjs')
    return
  }

  console.log(`▶ Firestore に書き込みます: ${results.length} 件`)
  let written = 0
  for (const { dealer, snapshot } of results) {
    const docId = `${dealer.dealerCode}_${snapshot.month}`
    const ref = db.collection('dealerMonthlySnapshots').doc(docId)
    const existing = await ref.get()
    await ref.set(
      {
        ...snapshot,
        snapshotAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    )
    written += 1
  }
  console.log(`  ${written}/${results.length} 件 書き込み完了`)

  try {
    const logRef = await db.collection('dealerAggregationLogs').add({
      type: 'dealer-monthly-snapshot',
      mode: DRY_RUN ? 'dry-run' : 'production',
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      month: windows.month,
      cutoffAt: Timestamp.fromDate(windows.cutoff),
      dealerCount: dealers.length,
      writtenCount: written,
      errorCount: errors.length,
      errors,
      source: 'bcart',
      scriptVersion: '2026-04-19.v2',
    })
    console.log(`📝 監査ログ保存: dealerAggregationLogs/${logRef.id}`)
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗:', e.message)
  }

  if (errors.length > 0) {
    console.log('')
    console.log(`⚠️  ${errors.length} 件の代理店でエラーが発生しました`)
    errors.forEach((e) => console.log(`   - ${e.dealerCode}: ${e.message}`))
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
