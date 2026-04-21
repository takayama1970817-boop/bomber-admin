/**
 * BカートAPI → Firestore 同期スクリプト
 * 使い方: node scripts/bcart-sync.mjs
 *
 * オプション:
 *   --year=2026         同期対象年（デフォルト: 2026）
 *   --all               全期間を同期
 *   --skip-products     受注明細の取得をスキップ（大量件数時の一次対策）
 *   --products-master   【Phase 2-4】商品マスタのみ同期して終了
 *                        Bカート products → Firestore publicProducts
 *                        + src/data/productsGenerated.js を再生成
 *                        ※ ホームページ公開デプロイに必要なのはこれだけ
 *   --dry-run           Firestore 書き込みと静的ファイル生成をスキップ
 *   --fresh             既存 checkpoint を無視して最初から取得
 *   --throttle-ms=250   成功リクエスト後の待機 ms（既定 250）
 *
 * レート制限対策（実装済）:
 *   - 指数バックオフ 5/10/20/40/60/120/180/240/300 秒 x 最大10回
 *   - Retry-After ヘッダ尊重
 *   - 成功後の throttle
 *   - 受注明細は 25ページ毎に checkpoint 保存、失敗時は --fresh なしで自動再開
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
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  BCART_BASE,
  getBcartToken,
  getFirebaseConfig,
  getScriptCredentials,
} from './_env.mjs'
import { toCategoryKey, toSlug, gradientFor } from '../src/data/products.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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
const throttleArg = args.find((a) => a.startsWith('--throttle-ms='))
const syncAll = args.includes('--all')
const skipProducts = args.includes('--skip-products')
const productsMasterOnly = args.includes('--products-master')
const dryRun = args.includes('--dry-run')
const freshRun = args.includes('--fresh')
const TARGET_YEAR = yearArg ? parseInt(yearArg.split('=')[1]) : 2026
// 成功レスポンス後の待機。既定 250ms（1リクエスト/250ms ≒ 4rps）。
const THROTTLE_MS = throttleArg ? parseInt(throttleArg.split('=')[1]) : 250

// === レート制限対応 fetch ===
// - 指数バックオフ（5s,10s,20s,40s,60s,120s,180s,240s,300s,300s 上限）
// - Retry-After ヘッダがあればそちらを尊重
// - 最大 10 回まで再試行、それでも通らなければ例外（checkpoint で再開可能）
// - 成功後も THROTTLE_MS 待機（連続リクエストの暴発防止）
const MAX_RETRIES = 10
const BACKOFF_SCHEDULE = [5, 10, 20, 40, 60, 120, 180, 240, 300, 300] // seconds
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    let res
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${BCART_TOKEN}` },
      })
    } catch (e) {
      // ネットワークエラーもバックオフ対象
      if (retry >= MAX_RETRIES) throw e
      const wait = BACKOFF_SCHEDULE[Math.min(retry, BACKOFF_SCHEDULE.length - 1)] * 1000
      console.log(`   ⚠️ ネットワークエラー (${e.message}) → ${wait / 1000}秒待機...`)
      await sleep(wait)
      continue
    }

    if (res.status === 429 || res.status === 503) {
      const retryAfterHeader = res.headers.get('retry-after')
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null
      const backoffSec =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec, 600)
          : BACKOFF_SCHEDULE[Math.min(retry, BACKOFF_SCHEDULE.length - 1)]
      const wait = backoffSec * 1000
      console.log(
        `   ⏳ レート制限 (${res.status}) retry=${retry + 1}/${MAX_RETRIES} → ${backoffSec}秒待機...`,
      )
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    const json = await res.json()
    // 成功後の連続暴発防止（レート制限に優しい同期）
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS)
    return json
  }
  throw new Error(
    'レート制限が継続中です。しばらく（30分〜1時間）待ってから --fresh を付けずに再実行すれば checkpoint から再開します。',
  )
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

// === Bカート 商品マスタ → 公開ページ用 shape 変換 ===
// Bカート products エンドポイントのレスポンス揺れ（事業者設定依存）を吸収する。
function transformBcartProduct(raw) {
  const code = String(raw.code ?? raw.product_code ?? raw.sku ?? raw.id ?? '').trim()
  if (!code) return null

  const name = String(raw.name ?? raw.product_name ?? '').trim()
  if (!name) return null

  const categoryName = String(
    raw.category_name ?? raw.category ?? raw.main_category ?? ''
  ).trim()
  const categoryKey = toCategoryKey(categoryName)

  const slugRaw = String(raw.slug ?? raw.url_slug ?? '').trim()
  const slug = slugRaw ? toSlug(slugRaw) : toSlug(code)

  const pub =
    raw.is_public == null && raw.status == null
      ? true
      : !(
          String(raw.is_public ?? raw.status ?? '')
            .trim()
            .toLowerCase() === '0' ||
          String(raw.is_public ?? raw.status ?? '')
            .trim()
            .toLowerCase() === 'false' ||
          String(raw.is_public ?? raw.status ?? '').trim() === '非公開'
        )

  const toNum = (v) => {
    if (v == null || v === '') return null
    const n = Number(String(v).replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }

  const description = String(raw.description ?? raw.long_description ?? '').trim()
  const shortDesc = String(
    raw.short_description ?? raw.summary ?? raw.sub_description ?? ''
  ).trim() || description.slice(0, 150)

  const featuresSrc = raw.features ?? raw.feature_list ?? ''
  const features = Array.isArray(featuresSrc)
    ? featuresSrc.map((f) => String(f).trim()).filter(Boolean)
    : String(featuresSrc)
        .split('|')
        .map((f) => f.trim())
        .filter(Boolean)

  const recommendedSrc = raw.recommended_for ?? raw.recommended ?? ''
  const recommendedFor = Array.isArray(recommendedSrc)
    ? recommendedSrc.map((s) => String(s).trim()).filter(Boolean)
    : String(recommendedSrc).split('|').map((s) => s.trim()).filter(Boolean)

  const usageHome =
    String(raw.usage_home ?? raw.usage ?? raw.how_to_use ?? '').trim() || null
  const usageSalon = String(raw.usage_salon ?? raw.usage_pro ?? '').trim() || null

  const image =
    String(raw.image_url ?? raw.image1 ?? raw.main_image ?? raw.thumbnail ?? '').trim() ||
    null

  // price は Bカート側の卸価格のため Firestore 公開コレクションに保存しない
  // （方針: 公開用項目のみ保存する）
  return {
    slug,
    code,
    name,
    category: categoryName || 'その他',
    categoryKey,
    badge: String(raw.badge ?? '').trim() || null,
    unit: String(raw.unit ?? raw.capacity ?? '').trim() || null,
    tagline: String(raw.tagline ?? raw.catchphrase ?? '').trim() || null,
    shortDesc,
    description,
    features,
    recommendedFor,
    usageSalon,
    usageHome,
    usage: usageHome, // 互換: 旧 usage 参照箇所のため残す
    image,
    gradient: gradientFor(categoryKey),
    displayOrder: toNum(raw.display_order ?? raw.sort_order ?? raw.sort) ?? 9999,
    isPublic: pub,
  }
}

// === 商品マスタのみ同期 ===
// 方針:
//  - 検証を全件完了させてから Firestore 書き込みへ進む（途中失敗で既存公開データを壊さない）
//  - slug 一意性を担保（衝突があれば書き込み前に中止）
//  - 公開項目のみ保存（price などは除外済み）
//  - --dry-run: Firestore 書き込みと生成ファイル出力を行わず計画だけ表示
//  - 既存 publicProducts にあって今回取得に無い / 非公開化された商品は isPublic=false に降格
async function syncProductsMaster() {
  console.log('=== Bカート商品マスタ → Firestore publicProducts 同期 ===')
  if (dryRun) console.log('*** DRY-RUN モード: 書き込み・生成ファイル更新は行いません ***')
  console.log('')

  // 0. Firebase認証
  console.log('0. Firebase認証中...')
  await signInWithEmailAndPassword(auth, SCRIPT_EMAIL, SCRIPT_PASSWORD)
  console.log('   認証OK\n')

  // 1. Bカートから全商品取得
  console.log('1. 商品データ取得中...')
  const rawProducts = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('products', { limit: PAGE_SIZE, offset })
    const key = Object.keys(data).find((k) => Array.isArray(data[k])) || 'products'
    const items = data[key]
    if (!items || items.length === 0) break
    rawProducts.push(...items)
    const total = data.meta?.total || '?'
    console.log(`   offset=${offset}: 累計${rawProducts.length}件 (全${total}件中)`)
    if (items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  console.log(`   → 商品: ${rawProducts.length}件\n`)

  if (rawProducts.length === 0) {
    console.error('  Bカートから商品を1件も取得できませんでした。既存 publicProducts は保護のため触りません。')
    process.exit(2)
  }

  // 2. shape 変換 + フィルタ
  console.log('2. 変換中...')
  const transformed = []
  const skipped = []
  for (const raw of rawProducts) {
    const item = transformBcartProduct(raw)
    if (!item) { skipped.push({ reason: 'code/name 欠落', raw }); continue }
    if (!item.isPublic) { skipped.push({ reason: '非公開', code: item.code }); continue }
    transformed.push(item)
  }
  // 安定ソート: displayOrder asc → code asc
  transformed.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder
    return a.code.localeCompare(b.code)
  })
  console.log(`   取込候補: ${transformed.length}件 / スキップ: ${skipped.length}件\n`)

  // 3. 事前検証: slug 一意性（衝突があれば一切書き込まずに中止）
  console.log('3. 検証中（slug一意性）...')
  const slugOwner = new Map()
  const slugConflicts = []
  for (const p of transformed) {
    const prev = slugOwner.get(p.slug)
    if (prev) slugConflicts.push({ slug: p.slug, codes: [prev.code, p.code] })
    else slugOwner.set(p.slug, p)
  }
  if (slugConflicts.length > 0) {
    console.error('   ❌ slug 衝突を検出しました。同期を中止します（既存公開データは保護）:')
    slugConflicts.forEach((c) =>
      console.error(`     - slug="${c.slug}" が code=${c.codes.join(' / ')} で衝突`),
    )
    process.exit(3)
  }
  console.log(`   OK（${transformed.length}件すべて一意）\n`)

  // 4. 既存 publicProducts との差分算出（stale = 今回無い / 非公開化）
  console.log('4. 既存 publicProducts との差分計算中...')
  const existingSnap = await getDocs(collection(db, 'publicProducts'))
  const newCodeSet = new Set(transformed.map((p) => p.code))
  const staleCodes = []
  existingSnap.docs.forEach((d) => {
    if (!newCodeSet.has(d.id)) {
      const data = d.data()
      // 既に isPublic=false なら再降格不要
      if (data?.isPublic !== false) staleCodes.push(d.id)
    }
  })
  console.log(`   既存: ${existingSnap.size}件 / 新規または更新: ${transformed.length}件 / 非公開化: ${staleCodes.length}件\n`)

  // 5. 書き込み（dry-run 時はスキップ）
  if (dryRun) {
    console.log('5. DRY-RUN: Firestore 書き込みと静的ファイル生成をスキップ\n')
  } else {
    console.log('5. Firestore publicProducts 書き込み中...')
    let batch = writeBatch(db)
    let batchCount = 0
    // 公開対象
    for (const p of transformed) {
      const ref = doc(db, 'publicProducts', p.code)
      batch.set(ref, { ...p, syncedAt: serverTimestamp() })
      batchCount++
      if (batchCount >= 450) { await batch.commit(); batch = writeBatch(db); batchCount = 0 }
    }
    // 非公開化（soft delete）
    for (const code of staleCodes) {
      const ref = doc(db, 'publicProducts', code)
      batch.set(ref, { isPublic: false, syncedAt: serverTimestamp() }, { merge: true })
      batchCount++
      if (batchCount >= 450) { await batch.commit(); batch = writeBatch(db); batchCount = 0 }
    }
    if (batchCount > 0) await batch.commit()
    console.log(`   → 公開: ${transformed.length}件 / 非公開化: ${staleCodes.length}件\n`)

    // 6. src/data/productsGenerated.js を再生成（ビルド時フォールバック）
    const outPath = resolve(__dirname, '..', 'src', 'data', 'productsGenerated.js')
    const header = `// ⚠️ 自動生成ファイル — scripts/bcart-sync.mjs --products-master で上書きされます
// 手動編集しないでください（カテゴリ辞書の拡張は src/data/products.js を編集）

`
    const body = `export const generatedProducts = ${JSON.stringify(transformed, null, 2)}\n\nexport const generatedAt = ${JSON.stringify(new Date().toISOString())}\n`
    writeFileSync(outPath, header + body, 'utf-8')
    console.log(`6. 静的フォールバック更新: ${outPath}\n`)
  }

  console.log('========================================')
  console.log(`  商品マスタ同期 ${dryRun ? 'DRY-RUN' : '完了'}`)
  console.log('========================================')
  console.log(`  取得:       ${rawProducts.length}件`)
  console.log(`  公開対象:   ${transformed.length}件`)
  console.log(`  非公開化:   ${staleCodes.length}件`)
  console.log(`  スキップ:   ${skipped.length}件`)
  if (skipped.length > 0) {
    const reasons = skipped.reduce((acc, s) => { acc[s.reason] = (acc[s.reason] || 0) + 1; return acc }, {})
    Object.entries(reasons).forEach(([r, c]) => console.log(`    - ${r}: ${c}件`))
  }
  console.log('')
}

// === メイン処理 ===
async function main() {
  // --products-master : 商品マスタのみ同期して終了
  if (productsMasterOnly) {
    await syncProductsMaster()
    process.exit(0)
  }

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

  // 2. 受注明細（オプション） + checkpoint 再開
  const prodMap = {}
  const checkpointPath = resolve(__dirname, '..', `.bcart-sync-checkpoint-${yearLabel}.json`)
  let resumedFromCheckpoint = false
  if (!skipProducts && orders.length > 0) {
    console.log('2. 受注明細を取得中（レート制限対応・checkpoint付き）...')
    const orderIds = new Set(orders.map((o) => o.id))
    let opOffset = 0

    // --- checkpoint 読み込み ---
    if (!freshRun && existsSync(checkpointPath)) {
      try {
        const saved = JSON.parse(readFileSync(checkpointPath, 'utf-8'))
        if (saved?.yearLabel === yearLabel && typeof saved.opOffset === 'number') {
          opOffset = saved.opOffset
          Object.assign(prodMap, saved.prodMap || {})
          resumedFromCheckpoint = true
          console.log(
            `   ♻️  checkpoint から再開: opOffset=${opOffset}, 既取得 ${Object.keys(prodMap).length} 注文分`,
          )
        }
      } catch (e) {
        console.log(`   ⚠️ checkpoint 読み込み失敗 (無視): ${e.message}`)
      }
    } else if (freshRun && existsSync(checkpointPath)) {
      console.log('   --fresh 指定: checkpoint を無視して最初から取得します')
    }

    // checkpoint 保存関数（try-catch で書き込み失敗しても処理を継続）
    const saveCheckpoint = () => {
      try {
        writeFileSync(
          checkpointPath,
          JSON.stringify({ yearLabel, opOffset, savedAt: new Date().toISOString(), prodMap }),
          'utf-8',
        )
      } catch (e) {
        console.log(`   ⚠️ checkpoint 保存失敗 (無視): ${e.message}`)
      }
    }

    // メインループ。失敗時は checkpoint を保存してから throw（再実行で再開可能）
    const CHECKPOINT_EVERY_PAGES = 25 // 25ページ = 500件ごと
    let pageSinceCheckpoint = 0
    try {
      while (true) {
        const data = await bcartFetch('order_products', { limit: PAGE_SIZE, offset: opOffset })
        const key = Object.keys(data).find((k) => Array.isArray(data[k])) || 'order_products'
        const items = data[key]
        if (!items || items.length === 0) break

        for (const p of items) {
          if (orderIds.has(p.order_id)) {
            if (!prodMap[p.order_id]) prodMap[p.order_id] = []
            prodMap[p.order_id].push(p)
          }
        }

        if (opOffset % 500 === 0) {
          console.log(`   offset=${opOffset}: ${Object.keys(prodMap).length}注文分の明細取得済み`)
        }
        if (items.length < PAGE_SIZE) break

        opOffset += PAGE_SIZE
        pageSinceCheckpoint++
        if (pageSinceCheckpoint >= CHECKPOINT_EVERY_PAGES) {
          saveCheckpoint()
          pageSinceCheckpoint = 0
        }
      }
    } catch (err) {
      // 中断時に checkpoint を保存（再実行で続きから）
      saveCheckpoint()
      console.error(
        `\n❌ 受注明細取得が中断されました: ${err.message}\n   checkpoint を ${checkpointPath} に保存しました。\n   30分〜1時間あけてから再実行してください（--fresh を付けなければ自動で再開します）。\n`,
      )
      throw err
    }

    // 完走したら checkpoint を削除
    if (existsSync(checkpointPath)) {
      try { unlinkSync(checkpointPath) } catch { /* ignore */ }
    }
    console.log(`   → 明細: ${Object.values(prodMap).flat().length}件\n`)
  } else {
    console.log('2. 受注明細: スキップ\n')
  }

  // 3. Firestore既存データ確認
  console.log('3. Firestore既存データ確認中...')
  const existingSnap = await getDocs(collection(db, 'orders'))
  const existingCodes = new Set()
  existingSnap.docs.forEach((d) => {
    const data = d.data()
    if (data.bcartCode) existingCodes.add(data.bcartCode)
    if (data.bcartOrderNumber) existingCodes.add(data.bcartOrderNumber)
  })
  console.log(`   既存: ${existingSnap.size}件\n`)

  // 4. サロンマップ
  const salonSnap = await getDocs(collection(db, 'salons'))
  const salonMap = {}
  salonSnap.docs.forEach((d) => {
    const data = d.data()
    if (data.name) salonMap[data.name] = d.id
  })

  // 5. Firestore書き込み（DRY-RUN 時は計画のみ）
  console.log(dryRun ? '4. DRY-RUN 計画表示（書き込みなし）...' : '4. Firestore書き込み中...')
  let imported = 0, skipped = 0, newSalons = 0
  let batch = writeBatch(db)
  let batchCount = 0

  // 月別集計
  const monthlyStats = {}

  for (const order of orders) {
    const code = order.code
    if (existingCodes.has(code)) { skipped++; continue }

    // 月別カウント
    const month = order.ordered_at.substring(0, 7) // YYYY-MM
    if (!monthlyStats[month]) monthlyStats[month] = { count: 0, total: 0 }
    monthlyStats[month].count++
    monthlyStats[month].total += (order.final_price || 0)

    const companyName = order.customer_comp_name || '（不明）'
    let salonId = salonMap[companyName]

    if (!salonId) {
      const salonRef = doc(collection(db, 'salons'))
      salonId = salonRef.id
      salonMap[companyName] = salonId
      newSalons++
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

    const items = (prodMap[order.id] || []).map((p) => ({
      name: p.product_name || '',
      sku: p.jan_code || '',
      campaign: p.set_name || '',
      unit: p.set_unit || '',
      price: p.unit_price || 0,
      qty: p.order_pro_count || 1,
    }))

    // orders.read strict 化に備え、Bカート側の customer_parent_id を dealerCode として刻む。
    // ロジックは src/lib/dealerCodeResolver.js の resolveDealerCodeFromBcartOrder と同一。
    // Node.js スクリプトから frontend lib を import できないため、ここではインライン化する。
    const dealerCode = String(
      order.customer_parent_id ?? order.parent_id ?? order.parent_member_id ?? '',
    ).trim()

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
    imported++

    if (batchCount >= 450) {
      if (!dryRun) {
        await batch.commit()
        console.log(`   ... ${imported}件書き込み済み`)
      }
      batch = writeBatch(db)
      batchCount = 0
    }
  }

  if (batchCount > 0 && !dryRun) {
    await batch.commit()
  }

  // === 結果表示 ===
  console.log('\n========================================')
  console.log(`  同期${dryRun ? 'DRY-RUN' : '完了'}: ${yearLabel}`)
  console.log('========================================')
  console.log(`  API取得:       ${orders.length}件`)
  console.log(`  新規取り込み:  ${imported}件`)
  console.log(`  スキップ:      ${skipped}件（重複）`)
  console.log(`  新規サロン:    ${newSalons}件`)

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
