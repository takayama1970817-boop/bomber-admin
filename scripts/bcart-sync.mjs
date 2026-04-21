/**
 * BカートAPI → Firestore 同期スクリプト
 * 使い方: node scripts/bcart-sync.mjs
 *
 * オプション:
 *   --year=2026       同期対象年（デフォルト: 2026）
 *   --all             全期間を同期
 *   --skip-products   受注明細の取得をスキップ
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  writeBatch,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore'
import {
  BCART_BASE,
  getBcartToken,
  getFirebaseConfig,
  getScriptCredentials,
} from './_env.mjs'

// === 設定 ===
const BCART_TOKEN = getBcartToken()
const PAGE_SIZE = 20

const firebaseConfig = getFirebaseConfig()
const { email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD } = getScriptCredentials()

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const args = process.argv.slice(2)
const yearArg = args.find((a) => a.startsWith('--year='))
const syncAll = args.includes('--all')
const skipProducts = args.includes('--skip-products')
const dryRun = args.includes('--dry-run')
const TARGET_YEAR = yearArg ? parseInt(yearArg.split('=')[1]) : 2026

// === レート制限対応 fetch ===
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
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  }
  throw new Error('レート制限が継続中。しばらく待ってから再実行してください。')
}

// === 二分探索で年の開始offsetを見つける ===
async function findYearStartOffset(year) {
  const targetDate = `${year}-01-01`
  const meta = await bcartFetch('orders', { limit: 1, offset: 0 })
  const total = meta.meta?.total || 0
  if (total === 0) return 0

  let lo = 0
  let hi = total
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const aligned = Math.floor(mid / PAGE_SIZE) * PAGE_SIZE
    const data = await bcartFetch('orders', { limit: PAGE_SIZE, offset: aligned })
    const orders = data.orders
    if (!orders || orders.length === 0) { hi = aligned; continue }
    if (orders[0].ordered_at < targetDate) {
      lo = aligned + PAGE_SIZE
    } else {
      hi = aligned
    }
  }
  return lo
}

// === メイン処理 ===
async function main() {
  const yearLabel = syncAll ? '全期間' : `${TARGET_YEAR}年`
  console.log(`=== BカートAPI → Firestore 同期（${yearLabel}） ===\n`)

  // 0. Firebase認証
  console.log('0. Firebase認証中...')
  await signInWithEmailAndPassword(auth, SCRIPT_EMAIL, SCRIPT_PASSWORD)
  console.log('   認証OK\n')

  // 1. 注文データ取得
  console.log('1. 注文データ取得中...')
  let startOffset = 0
  if (!syncAll) {
    console.log(`   ${TARGET_YEAR}年の開始位置を検索中...`)
    startOffset = await findYearStartOffset(TARGET_YEAR)
    console.log(`   開始offset: ${startOffset}`)
  }

  const yearStart = `${TARGET_YEAR}-01-01`
  const yearEnd = `${TARGET_YEAR + 1}-01-01`
  const orders = []
  let offset = startOffset
  let passedFilter = false

  while (true) {
    const data = await bcartFetch('orders', { limit: PAGE_SIZE, offset })
    const items = data.orders
    if (!items || items.length === 0) break

    for (const item of items) {
      if (syncAll || (item.ordered_at >= yearStart && item.ordered_at < yearEnd)) {
        orders.push(item)
        passedFilter = true
      } else if (passedFilter) {
        break
      }
    }

    const total = data.meta?.total || '?'
    if (offset % 100 === 0 || items.length < PAGE_SIZE) {
      console.log(`   offset=${offset}: 累計${orders.length}件 (全${total}件中)`)
    }
    if (passedFilter && items.length < PAGE_SIZE) break
    if (items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  console.log(`   → ${yearLabel}受注: ${orders.length}件\n`)

  // 2. 受注明細（オプション）
  const prodMap = {}
  if (!skipProducts && orders.length > 0) {
    console.log('2. 受注明細を取得中（レート制限対応）...')
    const orderIds = new Set(orders.map((o) => o.id))
    // order_products もoffsetベース。order_idでフィルタ
    // 最小のorder_idから効率化
    const minOrderId = Math.min(...orderIds)
    let opOffset = 0
    let foundAny = false

    while (true) {
      const data = await bcartFetch('order_products', { limit: PAGE_SIZE, offset: opOffset })
      const key = Object.keys(data).find((k) => Array.isArray(data[k])) || 'order_products'
      const items = data[key]
      if (!items || items.length === 0) break

      for (const p of items) {
        if (orderIds.has(p.order_id)) {
          if (!prodMap[p.order_id]) prodMap[p.order_id] = []
          prodMap[p.order_id].push(p)
          foundAny = true
        }
      }

      if (opOffset % 500 === 0) {
        console.log(`   offset=${opOffset}: ${Object.keys(prodMap).length}注文分の明細取得済み`)
      }
      if (items.length < PAGE_SIZE) break
      opOffset += PAGE_SIZE
    }
    console.log(`   → 明細: ${Object.values(prodMap).flat().length}件\n`)
  } else {
    console.log('2. 受注明細: スキップ\n')
  }

  // 3. Firestore既存データ確認
  // 速報 (bcart-email) 行を昇格更新できるよう、id と source を保持する
  console.log('3. Firestore既存データ確認中...')
  const existingSnap = await getDocs(collection(db, 'orders'))
  const existingByCode = new Map()
  let emailCount = 0
  let apiCount = 0
  let otherCount = 0
  existingSnap.docs.forEach((d) => {
    const data = d.data()
    const entry = { id: d.id, source: data.source || '' }
    if (data.bcartCode) existingByCode.set(data.bcartCode, entry)
    if (data.bcartOrderNumber) existingByCode.set(data.bcartOrderNumber, entry)
    if (data.source === 'bcart-email') emailCount++
    else if (data.source === 'bcart-api') apiCount++
    else otherCount++
  })
  console.log(`   既存 orders: ${existingSnap.size}件（bcart-email=${emailCount} / bcart-api=${apiCount} / その他=${otherCount}）\n`)

  // 4. サロンマップ
  const salonSnap = await getDocs(collection(db, 'salons'))
  const salonMap = {}
  salonSnap.docs.forEach((d) => {
    const data = d.data()
    if (data.name) salonMap[data.name] = d.id
  })

  // 5. Firestore書き込み
  const dryLabel = dryRun ? '（DRY_RUN: 書き込まず集計のみ）' : ''
  console.log(`4. Firestore書き込み${dryRun ? '（シミュレーション）' : ''}...${dryLabel}`)
  let imported = 0, promoted = 0, skipped = 0, newSalons = 0
  let batch = writeBatch(db)
  let batchCount = 0

  // 月別集計
  const monthlyStats = {}

  for (const order of orders) {
    const code = order.code

    // 月別カウント（新規・昇格ともに集計対象）
    const month = order.ordered_at.substring(0, 7) // YYYY-MM
    if (!monthlyStats[month]) monthlyStats[month] = { count: 0, total: 0 }

    const companyName = order.customer_comp_name || '（不明）'

    // orders.read strict 化に備え、Bカート側の customer_parent_id を dealerCode として刻む。
    // ロジックは src/lib/dealerCodeResolver.js の resolveDealerCodeFromBcartOrder と同一。
    // Node.js スクリプトから frontend lib を import できないため、ここではインライン化する。
    const dealerCode = String(
      order.customer_parent_id ?? order.parent_id ?? order.parent_member_id ?? '',
    ).trim()

    const items = (prodMap[order.id] || []).map((p) => ({
      name: p.product_name || '',
      sku: p.jan_code || '',
      campaign: p.set_name || '',
      unit: p.set_unit || '',
      price: p.unit_price || 0,
      qty: p.order_pro_count || 1,
    }))

    // 既存マッチ: bcart-email なら昇格、それ以外はスキップ
    const existing = existingByCode.get(code)
    if (existing) {
      if (existing.source === 'bcart-email') {
        // 月別集計（昇格は金額が確定するためここで集計）
        monthlyStats[month].count++
        monthlyStats[month].total += (order.final_price || 0)

        if (!dryRun) {
          const orderRef = doc(db, 'orders', existing.id)
          batch.update(orderRef, {
            orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
            total: order.final_price || 0,
            subtotal: order.total_price || 0,
            shipping: order.shipping_cost || 0,
            tax: order.tax || 0,
            paymentMethod: order.payment || '',
            customerNote: order.customer_message || '',
            items,
            source: 'bcart-api',
            bcartOrderId: order.id,
            companyName,
            ...(dealerCode ? { dealerCode } : {}),
            contact: order.customer_name || '',
            promotedFromEmailAt: serverTimestamp(),
          })

          const logRef = doc(collection(db, 'bcartPromotionLogs'))
          batch.set(logRef, {
            bcartCode: code,
            beforeSource: 'bcart-email',
            afterSource: 'bcart-api',
            orderId: existing.id,
            bcartOrderId: order.id,
            companyName,
            ...(dealerCode ? { dealerCode } : {}),
            via: 'scripts/bcart-sync.mjs',
            promotedAt: serverTimestamp(),
          })
          batchCount += 2
        }
        promoted++
      } else {
        skipped++
      }
      // flush batch if needed
      if (!dryRun && batchCount >= 450) {
        await batch.commit()
        console.log(`   ... ${imported}件新規 / ${promoted}件昇格 書き込み済み`)
        batch = writeBatch(db)
        batchCount = 0
      }
      continue
    }

    // 新規（新規は月別に集計）
    monthlyStats[month].count++
    monthlyStats[month].total += (order.final_price || 0)

    let salonId = salonMap[companyName]
    if (!salonId) {
      if (!dryRun) {
        const salonRef = doc(collection(db, 'salons'))
        salonId = salonRef.id
        salonMap[companyName] = salonId
        batch.set(salonRef, {
          name: companyName,
          contact: order.customer_name || '',
          phone: order.customer_tel || '',
          email: order.customer_email || '',
          address: `${order.customer_pref || ''}${order.customer_address1 || ''}${order.customer_address2 || ''}${order.customer_address3 || ''}`,
          zip: order.customer_zip || '',
          department: order.customer_department || '',
          plan: '',
          bcartRegistered: true,
          assignedUid: '',
          notes: 'BカートAPI同期で自動登録',
          lastOrderDate: Timestamp.fromDate(new Date(order.ordered_at)),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        batchCount++
      }
      newSalons++
    }

    if (!dryRun) {
      const orderRef = doc(collection(db, 'orders'))
      batch.set(orderRef, {
        salonId,
        orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
        total: order.final_price || 0,
        subtotal: order.total_price || 0,
        shipping: order.shipping_cost || 0,
        tax: order.tax || 0,
        paymentMethod: order.payment || '',
        campaign: '',
        customerNote: order.customer_message || '',
        items,
        source: 'bcart-api',
        bcartOrderNumber: code,
        bcartCode: code,
        bcartOrderId: order.id,
        companyName,
        ...(dealerCode ? { dealerCode } : {}),
        contact: order.customer_name || '',
        createdAt: serverTimestamp(),
      })
      batchCount++
    }
    imported++

    if (!dryRun && batchCount >= 450) {
      await batch.commit()
      console.log(`   ... ${imported}件新規 / ${promoted}件昇格 書き込み済み`)
      batch = writeBatch(db)
      batchCount = 0
    }
  }

  if (!dryRun && batchCount > 0) {
    await batch.commit()
  }

  // === 結果表示 ===
  console.log('\n========================================')
  console.log(`  ${dryRun ? '【DRY_RUN】想定結果' : '同期完了'}: ${yearLabel}`)
  console.log('========================================')
  console.log(`  API取得:       ${orders.length}件`)
  console.log(`  新規取り込み:  ${imported}件${dryRun ? '（書き込みなし）' : ''}`)
  console.log(`  昇格（速報→正式）: ${promoted}件${dryRun ? '（書き込みなし）' : ''}`)
  console.log(`  スキップ:      ${skipped}件（既に正式）`)
  console.log(`  新規サロン:    ${newSalons}件${dryRun ? '（書き込みなし）' : ''}`)

  if (Object.keys(monthlyStats).length > 0) {
    console.log('\n  【月別内訳（新規分のみ）】')
    const sorted = Object.entries(monthlyStats).sort(([a], [b]) => a.localeCompare(b))
    for (const [month, stats] of sorted) {
      console.log(`    ${month}: ${stats.count}件 / ¥${stats.total.toLocaleString()}`)
    }
  }

  console.log('')
  process.exit(0)
}

main().catch((e) => {
  console.error('エラー:', e.message)
  process.exit(1)
})
