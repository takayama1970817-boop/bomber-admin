/**
 * 代理店ダッシュボード用 日次スナップショット集計スクリプト
 *   dealerMonthlySnapshots/{dealerCode}_{YYYY-MM} を作成・更新する。
 *
 * 背景:
 *   代理店ポータルのダッシュボード（/dealer）は「5秒で行動判断」が目的。
 *   画面側で重い集計をせず、事前集計済みドキュメントを 1件 getDoc して即表示する設計。
 *   Blaze 未課金のため Cloud Functions ではなく本 Admin SDK スクリプトを cron/Actions 等で
 *   毎日 13:00（受注締め 12:00 の1時間後）に叩く想定。
 *
 * 仕様:
 *   - 集計カットオフ: 当日 12:00（`snapshotCutoffAt`）
 *   - 対象代理店   : allowedEmails where role == 'dealer' で dealerCode を持つ全員
 *   - 月          : 当月（YYYY-MM）。MONTH 環境変数で上書き可（過去月の再集計）
 *
 * 書き込むスキーマ（社長確定版）:
 *   dealerMonthlySnapshots/{dealerCode}_{YYYY-MM}
 *   {
 *     dealerCode, month,
 *     monthRevenue,                 // 当月1日〜カットオフ までの税込売上
 *     prevMonthSameDayRevenue,      // 前月1日〜同日 12:00 までの税込売上
 *     activeSalonCount,             // 直近30日以内に発注ありのサロン数
 *     totalSalonCount,              // dealerSalons 基準の総サロン数
 *     operationRate,                // activeSalonCount / totalSalonCount （0〜1）
 *     kickbackEstimate,             // 当月累計 × kbRate /100 （代理店ごと）
 *     salonsStale30, salonsStale14, // 要対応サロン（各最大5件）
 *     salonsNew,
 *     recentOrders,                 // 直近5件 [{ orderId, orderDate, salonName, totalAmount }]
 *     snapshotAt, snapshotCutoffAt, createdAt, updatedAt
 *   }
 *
 * 使用方法:
 *   # ドライラン（書き込まない）
 *   node scripts/aggregate-dealer-monthly.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false OPERATOR="社長 ボンバー" node scripts/aggregate-dealer-monthly.mjs
 *
 *   # 特定代理店のみ
 *   DEALER_CODE=12345 DRY_RUN=false node scripts/aggregate-dealer-monthly.mjs
 *
 *   # 過去月の再集計（カットオフは月末 23:59:59 扱い）
 *   MONTH=2026-03 DRY_RUN=false node scripts/aggregate-dealer-monthly.mjs
 *
 * 必要ファイル:
 *   scripts/service-account.json（Firebase Admin SDK 秘密鍵）
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const DEALER_CODE_FILTER = process.env.DEALER_CODE || null
const MONTH_OVERRIDE = process.env.MONTH || null

const MAX_LIST = 5

function toYearMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 当月カットオフと前月同日カットオフを計算する。
 * - 当月（MONTH_OVERRIDE なし）: 本日 12:00 がカットオフ
 * - 過去月（MONTH_OVERRIDE あり）: その月の最終日 23:59:59 をカットオフ
 */
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
    // その月の最終日 23:59:59
    cutoff = new Date(y, mm, 0, 23, 59, 59, 999)
  } else {
    month = toYearMonth(now)
    // 当日 12:00:00
    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  }

  const [y, mm] = month.split('-').map(Number)
  const thisMonthStart = new Date(y, mm - 1, 1, 0, 0, 0, 0)

  // 前月同日同時刻
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

  return { month, cutoff, thisMonthStart, prevMonthStart, prevMonthSameDay }
}

function tsToDate(ts) {
  if (!ts) return null
  if (typeof ts.toDate === 'function') return ts.toDate()
  if (ts instanceof Date) return ts
  return new Date(ts)
}

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

async function fetchDealerSalons(dealerCode) {
  const snap = await db.collection('dealerSalons').where('dealerCode', '==', dealerCode).get()
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

async function fetchDealerOrders(dealerCode) {
  const snap = await db.collection('orders').where('dealerCode', '==', dealerCode).get()
  return snap.docs.map((d) => {
    const data = d.data()
    return {
      id: d.id,
      companyName: data.companyName || '',
      total: Number(data.total) || 0,
      orderDate: tsToDate(data.orderDate),
    }
  })
}

function aggregateForDealer({ dealer, salons, orders, windows }) {
  const { month, cutoff, thisMonthStart, prevMonthStart, prevMonthSameDay } = windows

  // 当月売上（1日〜カットオフ）
  let monthRevenue = 0
  for (const o of orders) {
    if (!o.orderDate) continue
    if (o.orderDate >= thisMonthStart && o.orderDate <= cutoff) {
      monthRevenue += o.total
    }
  }

  // 前月同日比（前月1日〜前月同日同時刻）
  let prevMonthSameDayRevenue = 0
  for (const o of orders) {
    if (!o.orderDate) continue
    if (o.orderDate >= prevMonthStart && o.orderDate <= prevMonthSameDay) {
      prevMonthSameDayRevenue += o.total
    }
  }

  // orders から companyName 別の first/last 発注日を算出
  //   （dealerSalons 未登録でも orders 側で補足する。strict 化された orders.dealerCode が source of truth）
  const ordersByCompany = new Map() // name -> { first: Date, last: Date }
  for (const o of orders) {
    if (!o.companyName || !o.orderDate) continue
    const prev = ordersByCompany.get(o.companyName)
    if (!prev) {
      ordersByCompany.set(o.companyName, { first: o.orderDate, last: o.orderDate })
    } else {
      if (o.orderDate < prev.first) prev.first = o.orderDate
      if (o.orderDate > prev.last) prev.last = o.orderDate
    }
  }

  // dealerSalons を companyName → meta に
  const dealerSalonByName = new Map()
  for (const s of salons) {
    if (s.companyName) dealerSalonByName.set(s.companyName, s)
  }

  // 所属サロンの union（dealerSalons + orders）
  //   - dealerSalons: admin が手動で紐付けたサロン（メタ情報あり、type='own'/'sub' 等）
  //   - orders: strict化された dealerCode 一致で得られたサロン（自動で補足）
  //   - 両方に同一 companyName がある場合は dealerSalons 側のメタを優先利用
  const allNames = new Set([...dealerSalonByName.keys(), ...ordersByCompany.keys()])
  const ordersOnlyCount = [...ordersByCompany.keys()].filter((n) => !dealerSalonByName.has(n)).length

  const thirtyDaysAgo = new Date(cutoff.getTime() - 30 * 24 * 60 * 60 * 1000)
  const fourteenDaysAgo = new Date(cutoff.getTime() - 14 * 24 * 60 * 60 * 1000)

  let activeSalonCount = 0
  const salonsStale30 = []
  const salonsStale14 = []
  const salonsNew = []

  for (const name of allNames) {
    const meta = dealerSalonByName.get(name) || null
    const ord = ordersByCompany.get(name) || null
    const salonKey = meta?.id || `auto-${name}`
    const firstOrder = ord?.first || null
    const lastOrder = ord?.last || null
    const createdAt = tsToDate(meta?.createdAt)

    // アクティブ判定（直近30日以内に発注あり）
    if (lastOrder && lastOrder >= thirtyDaysAgo) activeSalonCount += 1

    // 新規判定:
    //   - firstOrderDate が 30日以内（orders ベース） — 実際に発注が始まった
    //   - orders がないが dealerSalons.createdAt が 30日以内 — 紐付けたばかりで未発注
    const isNewByOrder = firstOrder && firstOrder >= thirtyDaysAgo
    const isNewByLink = !firstOrder && createdAt && createdAt >= thirtyDaysAgo
    if (isNewByOrder || isNewByLink) {
      salonsNew.push({
        salonKey,
        name,
        firstOrderDate: firstOrder ? Timestamp.fromDate(firstOrder) : null,
        _sortKey: (firstOrder || createdAt).getTime(),
      })
      continue // 新規は stale に二重計上しない
    }

    // 停滞判定（新規でない場合のみ）
    if (!lastOrder) {
      // 発注なし & 新規でもない = 長期未発注扱い
      salonsStale30.push({ salonKey, name, lastOrderDate: null, _sortKey: 0 })
    } else if (lastOrder < thirtyDaysAgo) {
      salonsStale30.push({
        salonKey,
        name,
        lastOrderDate: Timestamp.fromDate(lastOrder),
        _sortKey: lastOrder.getTime(),
      })
    } else if (lastOrder < fourteenDaysAgo) {
      salonsStale14.push({
        salonKey,
        name,
        lastOrderDate: Timestamp.fromDate(lastOrder),
        _sortKey: lastOrder.getTime(),
      })
    }
  }

  // 総サロン数（dealerSalons + orders から補足した union）
  const totalSalonCount = allNames.size
  const operationRate = totalSalonCount > 0 ? activeSalonCount / totalSalonCount : 0

  // フォロー優先Top10（行動用・横断ランキング）
  //   - スコア高=優先。発注ゼロ(no-order)を最優先、次に stale30（古いほど上位）、stale14、最後に new。
  //   - active（14日以内発注）はフォロー不要なので除外。
  //   - nextAction はこの snapshot に同梱して、ダッシュボード側で迷わないようにする。
  const dayMs = 24 * 60 * 60 * 1000
  const prioritized = []
  for (const name of allNames) {
    const meta = dealerSalonByName.get(name) || null
    const ord = ordersByCompany.get(name) || null
    const salonKey = meta?.id || `auto-${name}`
    const firstOrder = ord?.first || null
    const lastOrder = ord?.last || null
    const createdAt = tsToDate(meta?.createdAt)

    let status
    let nextAction
    let priority
    let daysSinceLast = null

    if (!lastOrder) {
      if (createdAt && createdAt >= thirtyDaysAgo) {
        status = 'new'
        nextAction = '紐付け直後 → 初回コール'
        priority = 100
      } else {
        status = 'no-order'
        nextAction = '発注なし → ヒアリング'
        priority = 10000
      }
    } else {
      daysSinceLast = Math.floor((cutoff.getTime() - lastOrder.getTime()) / dayMs)
      const isNewByOrder = firstOrder && firstOrder >= thirtyDaysAgo
      if (isNewByOrder) {
        status = 'new'
        nextAction = '初回発注 → 御礼＋次回提案'
        priority = 200
      } else if (lastOrder < thirtyDaysAgo) {
        status = 'stale30'
        nextAction = '30日以上未発注 → 電話フォロー'
        priority = 5000 + daysSinceLast
      } else if (lastOrder < fourteenDaysAgo) {
        status = 'stale14'
        nextAction = '14日以上未発注 → リマインド'
        priority = 1000 + daysSinceLast
      } else {
        continue // 直近14日以内に発注あり → フォロー不要
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
  const followPriorityTop10 = prioritized
    .sort((a, b) => b._priority - a._priority)
    .slice(0, 10)
    .map(({ _priority, ...rest }) => rest)

  // ソート（古い方から / 新規は新しい方から）し、各最大5件
  const trimStale = (arr) =>
    arr
      .sort((a, b) => a._sortKey - b._sortKey) // 古い順 = 放置期間が長い順
      .slice(0, MAX_LIST)
      .map(({ _sortKey, ...rest }) => rest)
  const trimNew = (arr) =>
    arr
      .sort((a, b) => b._sortKey - a._sortKey) // 新しい順
      .slice(0, MAX_LIST)
      .map(({ _sortKey, ...rest }) => rest)

  // 最近の注文（直近5件）
  const recentOrders = orders
    .filter((o) => o.orderDate)
    .sort((a, b) => b.orderDate - a.orderDate)
    .slice(0, MAX_LIST)
    .map((o) => ({
      orderId: o.id,
      orderDate: Timestamp.fromDate(o.orderDate),
      salonName: o.companyName || '',
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
      operationRate: Math.round(operationRate * 1000) / 1000, // 小数3桁
      kickbackEstimate,
      salonsStale30: trimStale(salonsStale30),
      salonsStale14: trimStale(salonsStale14),
      salonsNew: trimNew(salonsNew),
      followPriorityTop10,
      recentOrders,
      snapshotCutoffAt: Timestamp.fromDate(cutoff),
    },
    sourceBreakdown: {
      dealerSalonsCount: dealerSalonByName.size,
      ordersDerivedCount: ordersOnlyCount,
    },
  }
}

async function main() {
  console.log('=== dealerMonthlySnapshots 集計 ===')
  const windows = resolveTimeWindows()
  console.log(`モード       : ${DRY_RUN ? '🟡 DRY RUN' : '🔴 本番実行'}`)
  console.log(`OPERATOR     : ${OPERATOR}`)
  console.log(`集計月       : ${windows.month}`)
  console.log(`カットオフ   : ${windows.cutoff.toISOString()}`)
  if (DEALER_CODE_FILTER) console.log(`対象代理店   : ${DEALER_CODE_FILTER} のみ`)
  console.log('')

  const dealers = await fetchDealers()
  console.log(`代理店 ${dealers.length} 社を処理します`)
  console.log('')

  const results = []
  const errors = []

  for (const dealer of dealers) {
    try {
      const [salons, orders] = await Promise.all([
        fetchDealerSalons(dealer.dealerCode),
        fetchDealerOrders(dealer.dealerCode),
      ])
      const { snapshot, sourceBreakdown } = aggregateForDealer({ dealer, salons, orders, windows })
      results.push({ dealer, snapshot, orderCount: orders.length, salonCount: salons.length })
      const kbHint = dealer.kbRate > 0 ? '' : ' ⚠️ kbRate 未設定'
      console.log(
        `  ✅ ${dealer.dealerCode} ${dealer.companyName || ''} ` +
          `月売上 ¥${snapshot.monthRevenue.toLocaleString()} / ` +
          `前月同日 ¥${snapshot.prevMonthSameDayRevenue.toLocaleString()} / ` +
          `稼働 ${snapshot.activeSalonCount}/${snapshot.totalSalonCount} ` +
          `(dealerSalons ${sourceBreakdown.dealerSalonsCount} + orders由来 ${sourceBreakdown.ordersDerivedCount}) / ` +
          `見込KB ¥${snapshot.kickbackEstimate.toLocaleString()}${kbHint}`,
      )
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

  // 監査ログ（ordersBackfillLogs / subRoleBackfillLogs と同パターン）
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
      scriptVersion: '2026-04-19.v1',
    })
    console.log(`📝 監査ログ保存: dealerAggregationLogs/${logRef.id}`)
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗（処理自体は完了）:', e.message)
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
