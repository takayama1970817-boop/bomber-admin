/**
 * BカートAPI → Firestore 同期スクリプト
 * 使い方: node scripts/bcart-sync.mjs --project=bomber-admin --days=7 --dry-run
 *
 * 必須:
 *   --project=PROJECT_ID            対象 Firebase project_id を明示。
 *                                   service-account.json の project_id と一致しない場合は即時終了。
 *
 * オプション:
 *   --service-account=PATH          使用する service account JSON のパス（既定: scripts/service-account.json）
 *   --year=2026                     同期対象年（デフォルト: 2026）
 *   --all                           全期間を同期
 *   --days=7                        直近N日のみ同期（--year/--all より優先）
 *   --skip-products                 受注明細の取得をスキップ
 *   --dry-run                       書き込まず集計のみ
 *
 * 例:
 *   # テスト DB で動作確認
 *   node scripts/bcart-sync.mjs --project=bomber-admin-test --service-account=scripts/service-account.json --days=7 --dry-run
 *
 *   # 本番 DB へ同期
 *   node scripts/bcart-sync.mjs --project=bomber-admin --service-account=scripts/service-account-prod.json --days=7
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import {
  getFirestore,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken } from './_env.mjs'
import { normalizeCompanyName } from '../src/lib/nameNormalize.js'
import { buildDealerCodeMap, resolveDealerCode } from '../src/lib/dealerCodeMapping.js'

// companyNameKey の未知ケースプレースホルダ。集計時に __unknown__ をまとめて扱う。
const UNKNOWN_COMPANY_KEY = '__unknown__'

// === 設定 ===
const BCART_TOKEN = getBcartToken()
const PAGE_SIZE = 20

// === CLI 引数パース（service account / project は SDK 初期化前に必要なので先に処理）===
const cliArgs = process.argv.slice(2)
function getFlagValue(name) {
  const hit = cliArgs.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : null
}

// --project は誤実行防止のため必須。service-account.json の project_id と一致しないと exit。
const REQUIRED_PROJECT_ID = getFlagValue('--project')
if (!REQUIRED_PROJECT_ID) {
  console.error('❌ --project=PROJECT_ID は必須です。')
  console.error('   例: --project=bomber-admin-test （テスト）')
  console.error('       --project=bomber-admin      （本番）')
  process.exit(1)
}

// --service-account でファイルパスを切替可能。既定は scripts/service-account.json。
const SA_FLAG = getFlagValue('--service-account')
const SERVICE_ACCOUNT_PATH = SA_FLAG
  ? (isAbsolute(SA_FLAG) ? SA_FLAG : resolve(process.cwd(), SA_FLAG))
  : new URL('./service-account.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`❌ service account JSON が見つかりません: ${SERVICE_ACCOUNT_PATH}`)
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))

// project_id 厳格チェック: SA と --project が食い違えば即時終了（fail-closed）。
if (serviceAccount.project_id !== REQUIRED_PROJECT_ID) {
  console.error('❌ project_id 不一致のため停止します（誤実行防止）。')
  console.error(`   --project              : ${REQUIRED_PROJECT_ID}`)
  console.error(`   service account        : ${serviceAccount.project_id}`)
  console.error(`   service account file   : ${SERVICE_ACCOUNT_PATH}`)
  process.exit(1)
}

console.log('========================================')
console.log('  Firebase Admin SDK 初期化')
console.log(`  project_id     : ${serviceAccount.project_id}`)
console.log(`  client_email   : ${serviceAccount.client_email}`)
console.log(`  service account: ${SERVICE_ACCOUNT_PATH}`)
console.log('========================================\n')

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()
// Admin SDK は serverTimestamp を FieldValue 経由で扱うため、互換 alias を用意
const serverTimestamp = () => FieldValue.serverTimestamp()

const args = cliArgs
const yearArg = args.find((a) => a.startsWith('--year='))
const daysArg = args.find((a) => a.startsWith('--days='))
const syncAll = args.includes('--all')
const skipProducts = args.includes('--skip-products')
const dryRun = args.includes('--dry-run')
const TARGET_YEAR = yearArg ? parseInt(yearArg.split('=')[1]) : 2026
// --days=N が指定されたときだけ「直近Nモード」として扱う。
// year / all より優先し、findStartOffsetByDate で開始 offset を決める。
const RECENT_DAYS = daysArg ? parseInt(daysArg.split('=')[1]) : null
const recentMode = Number.isFinite(RECENT_DAYS) && RECENT_DAYS > 0

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

// === 二分探索で「ordered_at >= targetDate」となる最初の offset を見つける ===
//
// Bカート orders API は ordered_at 昇順（古い順）を返す前提。
// findYearStartOffset(year) はこの一般化版に置き換えた薄いラッパ。
//
// TODO: Bカート API 側に ordered_at の範囲指定パラメータ（例: from/to/since 等）
//       が存在するか公式ドキュメントを確認し、可能なら API 側フィルタに切替えて
//       本探索自体を不要にする。現状は param 名が不明なため二分探索方式で安全に絞る。
async function findStartOffsetByDate(targetDate) {
  const meta = await bcartFetch('orders', { limit: 1, offset: 0 })
  const total = meta.meta?.total || 0
  if (total === 0) return { startOffset: 0, total: 0 }

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
  return { startOffset: lo, total }
}

async function findYearStartOffset(year) {
  const { startOffset } = await findStartOffsetByDate(`${year}-01-01`)
  return startOffset
}

// === メイン処理 ===
async function main() {
  const yearLabel = recentMode
    ? `直近${RECENT_DAYS}日`
    : (syncAll ? '全期間' : `${TARGET_YEAR}年`)
  console.log(`=== BカートAPI → Firestore 同期（${yearLabel}） ===\n`)

  // 0. Firebase認証（Admin SDK 初期化はモジュールロード時に完了済み）
  console.log('0. Firebase認証: Admin SDK (service-account.json)\n')

  // 1. 注文データ取得
  // Bカート orders API は ordered_at 昇順（古い順）。offset=0 は最古。
  // 直近Nモード・年指定モードのいずれも、二分探索で「cutoff 以降の最初の offset」を見つけ、
  // そこから前進して読み切る方式に統一する。
  console.log('1. 注文データ取得中...')

  // 直近Nモード用の cutoff（YYYY-MM-DD）。
  let cutoffStr = null
  if (recentMode) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - RECENT_DAYS)
    cutoffStr = cutoff.toISOString().slice(0, 10)
  }

  let startOffset = 0
  if (recentMode) {
    console.log(`   直近${RECENT_DAYS}日モード cutoff (>=): ${cutoffStr}`)
    console.log(`   開始位置を二分探索中...`)
    const { startOffset: so, total: t } = await findStartOffsetByDate(cutoffStr)
    startOffset = so
    console.log(`   開始offset: ${startOffset} / 全${t}件`)
  } else if (!syncAll) {
    console.log(`   ${TARGET_YEAR}年の開始位置を検索中...`)
    startOffset = await findYearStartOffset(TARGET_YEAR)
    console.log(`   開始offset: ${startOffset}`)
  }

  const yearStart = `${TARGET_YEAR}-01-01`
  const yearEnd = `${TARGET_YEAR + 1}-01-01`
  const orders = []
  let offset = startOffset
  let passedFilter = false
  // 安全策: 直近Nモードで想定外に大量ページングしないよう上限を設ける。
  // 1ページ20件 × 50ページ = 最大 1000件 で打ち切り。
  // 通常の「直近7日」運用ではこのキャップに到達しないが、
  // 二分探索のバグ等でページングが暴走した場合のフェイルセーフ。
  const MAX_RECENT_PAGES = 50
  let recentPageCount = 0

  while (true) {
    const data = await bcartFetch('orders', { limit: PAGE_SIZE, offset })
    const items = data.orders
    if (!items || items.length === 0) break

    for (const item of items) {
      const inRange = recentMode
        ? item.ordered_at >= cutoffStr
        : (syncAll || (item.ordered_at >= yearStart && item.ordered_at < yearEnd))
      if (inRange) {
        orders.push(item)
        passedFilter = true
      } else if (passedFilter) {
        // 古い順なので、いったん範囲に入ってから外れることは通常ない。
        // year モードで yearEnd を超えた場合のみここに来る。
        break
      }
    }

    const total = data.meta?.total || '?'
    if (offset % 100 === 0 || items.length < PAGE_SIZE) {
      console.log(`   offset=${offset}: 累計${orders.length}件 (全${total}件中)`)
    }
    if (passedFilter && items.length < PAGE_SIZE) break
    if (items.length < PAGE_SIZE) break

    if (recentMode) {
      recentPageCount++
      if (recentPageCount >= MAX_RECENT_PAGES) {
        console.warn(
          `   ⚠️  MAX_RECENT_PAGES=${MAX_RECENT_PAGES} に到達したため打ち切ります。`
          + ' （取得済み ' + orders.length + ' 件）',
        )
        break
      }
    }
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
  const existingSnap = await db.collection('orders').get()
  // bcartCode と bcartOrderNumber は同値のことが多いが、旧データで異なる
  // ケースがあるため両方を Map キーに入れて dedup 判定の取りこぼしを防ぐ。
  // どちらか一方しか入っていない古い行も同じ既存 entry を指すよう冗長登録する。
  const existingByCode = new Map()
  let emailCount = 0
  let apiCount = 0
  let otherCount = 0
  let deprecatedCount = 0
  existingSnap.docs.forEach((d) => {
    const data = d.data()
    // 旧データ（isDeprecated === true）は existing 判定から除外する。
    // 同じ bcartCode を持つ deprecated 行が残っていても、新規取り込み・
    // メール→API 昇格が deprecated 行を existing と誤判定してスキップされる
    // のを防ぐため。
    // TODO: deprecated 行と新規行の bcartCode 衝突が残った場合は、
    //       後続の cleanup スクリプト or 手動で deprecated 行を物理削除する。
    if (data.isDeprecated === true) {
      deprecatedCount++
      return
    }
    const entry = { id: d.id, source: data.source || '' }
    if (data.bcartCode) existingByCode.set(data.bcartCode, entry)
    if (data.bcartOrderNumber) existingByCode.set(data.bcartOrderNumber, entry)
    if (data.source === 'bcart-email') emailCount++
    else if (data.source === 'bcart-api') apiCount++
    else otherCount++
  })
  console.log(
    `   既存 orders: ${existingSnap.size}件`
    + `（bcart-email=${emailCount} / bcart-api=${apiCount} / その他=${otherCount}`
    + ` / deprecated除外=${deprecatedCount}）\n`,
  )

  // 4. サロンマップ
  const salonSnap = await db.collection('salons').get()
  const salonMap = {}
  salonSnap.docs.forEach((d) => {
    const data = d.data()
    if (data.name) salonMap[data.name] = d.id
  })

  // 4b. dealerCode マッピング（Bカート 親会員 ID → アプリ dealerCode）
  // allowedEmails (role=dealer) の bcartParentId / dealerCode から構築。
  // 既知マッピング: J0016=v1, J0017=v2, ..., J0021=v6
  // 未マッピング v 系は fail-closed（dealerCode を書き込まない）
  console.log('   dealerCode マッピング構築中...')
  const allowedSnap = await db.collection('allowedEmails').where('role', '==', 'dealer').get()
  const dealerCodeMap = buildDealerCodeMap(allowedSnap.docs.map((d) => d.data()))
  console.log(`   登録 dealer: ${allowedSnap.size} 件 / マッピング: ${dealerCodeMap.byBcartParent.size} 件\n`)

  // 5. Firestore書き込み
  const dryLabel = dryRun ? '（DRY_RUN: 書き込まず集計のみ）' : ''
  console.log(`4. Firestore書き込み${dryRun ? '（シミュレーション）' : ''}...${dryLabel}`)
  let imported = 0, promoted = 0, skipped = 0, newSalons = 0
  let batch = db.batch()
  let batchCount = 0

  // 月別集計
  const monthlyStats = {}

  for (const order of orders) {
    const code = order.code

    // 月別カウント（新規・昇格ともに集計対象）
    const month = order.ordered_at.substring(0, 7) // YYYY-MM
    if (!monthlyStats[month]) monthlyStats[month] = { count: 0, total: 0 }

    const companyName = order.customer_comp_name || '（不明）'
    // 集計・検索用の正規化キー（生の companyName は表示用に維持）。
    // src/lib/nameNormalize.js と同一ロジックを使い、画面側の防御層と揃える。
    const companyNameKey = normalizeCompanyName(companyName) || UNKNOWN_COMPANY_KEY

    // orders.read strict 化に備え、Bカート側の customer_parent_id を dealerCode として刻む。
    // dealerCodeMap でマッピング層を経由（v1 → J0016 等）。
    // 未マッピング v 系は resolveDealerCode が '' を返す（fail-closed）。
    const rawParent = String(
      order.customer_parent_id ?? order.parent_id ?? order.parent_member_id ?? '',
    ).trim()
    const dealerCode = resolveDealerCode(rawParent, dealerCodeMap)

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
          const orderRef = db.collection('orders').doc(existing.id)
          batch.update(orderRef, {
            orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
            total: order.final_price || 0,
            subtotal: order.total_price || 0,
            shipping: order.shipping_cost || 0,
            tax: order.tax || 0,
            // Bカート final_price 検算用の内訳:
            //   final_price = total_price + tax + shipping_cost + COD_cost − use_point
            // 売上集計の正本は引き続き total（= final_price）。
            // codCost / usePoint は表示には使わず、検算・将来分析用。
            codCost: order.COD_cost || 0,
            usePoint: order.use_point || 0,
            paymentMethod: order.payment || '',
            customerNote: order.customer_message || '',
            items,
            source: 'bcart-api',
            bcartOrderId: order.id,
            companyName,
            companyNameKey,
            ...(dealerCode ? { dealerCode } : {}),
            contact: order.customer_name || '',
            promotedFromEmailAt: serverTimestamp(),
          })

          const logRef = db.collection('bcartPromotionLogs').doc()
          batch.set(logRef, {
            bcartCode: code,
            beforeSource: 'bcart-email',
            afterSource: 'bcart-api',
            orderId: existing.id,
            bcartOrderId: order.id,
            companyName,
            companyNameKey,
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
        batch = db.batch()
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
        const salonRef = db.collection('salons').doc()
        salonId = salonRef.id
        salonMap[companyName] = salonId
        batch.set(salonRef, {
          name: companyName,
          nameKey: companyNameKey,
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
      const orderRef = db.collection('orders').doc()
      batch.set(orderRef, {
        salonId,
        orderDate: Timestamp.fromDate(new Date(order.ordered_at)),
        total: order.final_price || 0,
        subtotal: order.total_price || 0,
        shipping: order.shipping_cost || 0,
        tax: order.tax || 0,
        // Bカート final_price 検算用の内訳:
        //   final_price = total_price + tax + shipping_cost + COD_cost − use_point
        // 売上集計の正本は引き続き total（= final_price）。
        // codCost / usePoint は表示には使わず、検算・将来分析用。
        codCost: order.COD_cost || 0,
        usePoint: order.use_point || 0,
        paymentMethod: order.payment || '',
        campaign: '',
        customerNote: order.customer_message || '',
        items,
        source: 'bcart-api',
        bcartOrderNumber: code,
        bcartCode: code,
        bcartOrderId: order.id,
        companyName,
        companyNameKey,
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
      batch = db.batch()
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
  console.log(`  昇格(速報→正式): ${promoted}件${dryRun ? '（書き込みなし）' : ''}`)
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
