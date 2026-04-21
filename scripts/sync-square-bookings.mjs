/**
 * Square Bookings 同期スクリプト（Admin SDK + Square Bookings API v2）
 *
 * 目的:
 *   Square Developer API から予約（Bookings）を取得し、Firestore の
 *   reservations/{square_<booking_id>} に upsert する。
 *
 *   予約の正本は Square。自社システムは閲覧用のコピーを保持する。
 *
 * 設計方針（社長確定の3要件 + 追記ルール）:
 *   1. ドライラン既定       — 実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全           — doc ID = `square_<booking.id>` の setDoc({ merge: true })
 *                             で upsert、何度実行しても同じ結果（冪等）
 *   3. Firestore 監査ログ   — 実行ごとに squareSyncLogs コレクションへサマリ保存
 *   4. 取込不能な予約は握りつぶさない
 *                          — failedEntries に { externalId, reason } を残す
 *                             他の正常データは可能な限り継続処理する
 *
 * 使用方法:
 *   # ドライラン（既定）
 *   node scripts/sync-square-bookings.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false node scripts/sync-square-bookings.mjs
 *
 *   # 記録者メモ
 *   OPERATOR="社長 ボンバー" DRY_RUN=false node scripts/sync-square-bookings.mjs
 *
 *   # 取得期間の指定（既定: 過去7日〜未来24日 = 31日）
 *   # ※ Square API は期間が 31日以内でないと 400 を返すため、同スクリプトは
 *   #    起動時に 31日超過なら事前停止する。
 *   START_AT_MIN=2026-04-01 START_AT_MAX=2026-05-01 node scripts/sync-square-bookings.mjs
 *
 * 必要な環境変数（.env.local）:
 *   SQUARE_ACCESS_TOKEN                          Square Developer Dashboard で発行
 *   SQUARE_LOCATION_ID                           同期対象の location（サロン）ID
 *   SQUARE_LOCATION_TO_SALON_COMPANY_NAME        Firestore 側の salonCompanyName
 *   SQUARE_ENV                                   'production' | 'sandbox'（既定: production）
 *
 * 必要な認証ファイル:
 *   scripts/service-account.json（Firebase Admin SDK 秘密鍵）
 *
 * 出力:
 *   - 標準出力: サマリ + 失敗サンプル
 *   - Firestore: reservations/{square_<id>} upsert
 *   - Firestore: squareSyncLogs/{auto-id} 実行サマリ
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

// ========================================
// 環境変数の取り込み
// ========================================
// Node 22+ は --env-file を使わなくても process.env が見える想定。
// ただし .env.local を使うために loadDotEnv を書いておく。
function loadDotEnv() {
  const paths = [
    new URL('../.env.local', import.meta.url),
    new URL('../.env', import.meta.url),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!m) continue
      const [, k, rawV] = m
      if (process.env[k]) continue // 既に環境から入っていれば尊重
      const v = rawV.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      process.env[k] = v
    }
    break // .env.local を見つけたら .env は読まない
  }
}
loadDotEnv()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID
const SALON_COMPANY_NAME = process.env.SQUARE_LOCATION_TO_SALON_COMPANY_NAME
const SQUARE_ENV = process.env.SQUARE_ENV || 'production'

if (!SQUARE_ACCESS_TOKEN) {
  console.error('❌ SQUARE_ACCESS_TOKEN が未設定です（.env.local に追加してください）。')
  process.exit(1)
}
if (!SQUARE_LOCATION_ID) {
  console.error('❌ SQUARE_LOCATION_ID が未設定です（.env.local に追加してください）。')
  process.exit(1)
}
if (!SALON_COMPANY_NAME) {
  console.error('❌ SQUARE_LOCATION_TO_SALON_COMPANY_NAME が未設定です（取り込み先 salon の companyName）。')
  process.exit(1)
}

const SQUARE_BASE = SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com'

// 取得期間の既定: 過去7日 〜 未来24日（合計31日。Square API の 31日以内制限に厳密準拠）
// Square Bookings API は start_at_min / start_at_max の差分が 31日超だと 400 で拒否する。
// Phase 1 テスト運用では未来寄りに多めに取りたいので、過去はやや狭めに確保。
const SQUARE_MAX_RANGE_DAYS = 31
const MS_PER_DAY = 24 * 60 * 60 * 1000
const now = new Date()
const defaultMin = new Date(now.getTime() - 7 * MS_PER_DAY)
const defaultMax = new Date(now.getTime() + 24 * MS_PER_DAY)
const START_AT_MIN = process.env.START_AT_MIN
  ? new Date(process.env.START_AT_MIN)
  : defaultMin
const START_AT_MAX = process.env.START_AT_MAX
  ? new Date(process.env.START_AT_MAX)
  : defaultMax

// 入力値バリデーション
if (Number.isNaN(START_AT_MIN.getTime())) {
  console.error(`❌ START_AT_MIN が不正な日時です: "${process.env.START_AT_MIN}"`)
  process.exit(1)
}
if (Number.isNaN(START_AT_MAX.getTime())) {
  console.error(`❌ START_AT_MAX が不正な日時です: "${process.env.START_AT_MAX}"`)
  process.exit(1)
}
if (START_AT_MIN.getTime() >= START_AT_MAX.getTime()) {
  console.error(
    `❌ START_AT_MIN (${START_AT_MIN.toISOString()}) が START_AT_MAX (${START_AT_MAX.toISOString()}) 以降になっています。`,
  )
  process.exit(1)
}

// Square API 31日以内制限ガード
// env で明示指定した場合も、既定値でも必ずチェックする（API 側で 400 になる前にここで止める）
const rangeDays = (START_AT_MAX.getTime() - START_AT_MIN.getTime()) / MS_PER_DAY
if (rangeDays > SQUARE_MAX_RANGE_DAYS) {
  console.error('❌ 取得期間が Square API の 31日制限を超えています。')
  console.error(`   指定された期間: ${rangeDays.toFixed(2)} 日`)
  console.error(`   START_AT_MIN  : ${START_AT_MIN.toISOString()}`)
  console.error(`   START_AT_MAX  : ${START_AT_MAX.toISOString()}`)
  console.error(`   上限          : ${SQUARE_MAX_RANGE_DAYS} 日`)
  console.error('')
  console.error('   対応: START_AT_MIN / START_AT_MAX を 31日以内の範囲に調整するか、')
  console.error('   環境変数を外して既定値（過去7日〜未来24日 = 31日）を使ってください。')
  process.exit(1)
}

const SCRIPT_VERSION = '2026-04-18.v2'
const LOG_COLLECTION = 'squareSyncLogs'
const RESERVATIONS_COLLECTION = 'reservations'

// ========================================
// Square API ヘルパー
// ========================================
async function squareFetch(path, query = {}) {
  const url = new URL(`${SQUARE_BASE}${path}`)
  Object.entries(query).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  // Square 推奨バージョンはヘッダで指定
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      'Square-Version': '2024-10-17',
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Square API error ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

/** 指定期間の Bookings を全ページ取得 */
async function fetchAllBookings() {
  const all = []
  let cursor = null
  while (true) {
    const data = await squareFetch('/v2/bookings', {
      location_id: SQUARE_LOCATION_ID,
      start_at_min: START_AT_MIN.toISOString(),
      start_at_max: START_AT_MAX.toISOString(),
      limit: 200,
      cursor,
    })
    const items = data.bookings || []
    all.push(...items)
    process.stdout.write(`\r  Square 取得中: ${all.length} 件`)
    cursor = data.cursor
    if (!cursor) break
  }
  process.stdout.write('\n')
  return all
}

/** 顧客情報（任意で詳細取得） */
const customerCache = new Map()
async function fetchCustomer(customerId) {
  if (!customerId) return null
  if (customerCache.has(customerId)) return customerCache.get(customerId)
  try {
    const data = await squareFetch(`/v2/customers/${customerId}`)
    customerCache.set(customerId, data.customer || null)
    return data.customer || null
  } catch (e) {
    // 顧客取得失敗は致命的にしない。予約データだけ残す
    console.warn(`   ⚠️  customer 取得失敗 ${customerId}: ${e.message}`)
    customerCache.set(customerId, null)
    return null
  }
}

// ========================================
// Booking → reservation ドキュメント変換
// ========================================
function toTimestamp(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Timestamp.fromDate(d)
}

/** Square booking.status（EST_* 形式）を自社の簡易 status にマッピング */
function mapStatus(squareStatus) {
  switch (squareStatus) {
    case 'PENDING':             return 'pending'
    case 'ACCEPTED':            return 'confirmed'
    case 'DECLINED':
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_SELLER': return 'cancelled'
    case 'NO_SHOW':
    case 'COMPLETED':           return 'completed'
    default:                    return 'pending'
  }
}

/**
 * Square booking を reservations 用ドキュメントに変換。
 * 変換失敗（必須欠損など）は throw して failedEntries に積む。
 */
function buildReservationDoc(booking, customer) {
  if (!booking?.id) throw new Error('booking.id が欠損')
  const segments = booking.appointment_segments || []
  const firstSeg = segments[0] || {}

  // end_at は Square の appointment_segments の合計 duration から算出
  const totalMinutes = segments.reduce(
    (sum, s) => sum + (Number(s.duration_minutes) || 0),
    0,
  )
  const startAt = toTimestamp(booking.start_at)
  const endAt = startAt && totalMinutes > 0
    ? Timestamp.fromMillis(startAt.toMillis() + totalMinutes * 60 * 1000)
    : null

  const customerName = customer
    ? [customer.family_name, customer.given_name].filter(Boolean).join(' ')
      || customer.company_name
      || customer.nickname
      || ''
    : ''
  const customerPhone = customer?.phone_number || ''
  const customerEmail = customer?.email_address || ''

  return {
    externalId: booking.id,
    source: 'square',
    squareLocationId: SQUARE_LOCATION_ID,
    salonCompanyName: SALON_COMPANY_NAME,

    customerName,
    customerPhone,
    customerEmail,

    // Phase 1 はサービス名・スタッフ名の解決まではやらない（id のみ保持）
    menuName: '', // TODO Phase 2: catalog API で service_variation_id → 名前解決
    menuId: firstSeg.service_variation_id || '',
    staffName: '', // TODO Phase 2: team_members API で team_member_id → 名前解決
    staffId: firstSeg.team_member_id || '',

    startAt,
    endAt,
    status: mapStatus(booking.status),

    notes: booking.customer_note || '',
    reservationCode: booking.id, // Square は別途コード体系がないため id を流用
    externalCreatedAt: toTimestamp(booking.created_at),
    externalUpdatedAt: toTimestamp(booking.updated_at),

    // 将来の来店連動用フィールド（Phase 2 で visits/* と接続する予約済み）
    visitId: null,

    // Square 元データをそのまま保持（監査・将来拡張用）
    raw: booking,

    updatedAt: FieldValue.serverTimestamp(),
    // createdAt は merge: true で初回のみ保存
  }
}

/** reservation doc ID の命名規則 */
function reservationDocId(externalId) {
  return `square_${externalId}`
}

// ========================================
// メイン同期処理
// ========================================
async function writeAuditLog({ mode, results, failedEntries, period }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'square-bookings-sync',
      mode,
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      squareLocationId: SQUARE_LOCATION_ID,
      salonCompanyName: SALON_COMPANY_NAME,
      squareEnv: SQUARE_ENV,
      period: {
        startAtMin: period.startAtMin,
        startAtMax: period.startAtMax,
      },
      results,
      failedEntries,
      scriptVersion: SCRIPT_VERSION,
    })
    console.log(`\n📝 監査ログを保存しました: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    // ログ書き込み失敗は同期処理自体を壊さない
    console.error('⚠️  監査ログ書き込み失敗（同期処理は完了しています）:', e.message)
    return null
  }
}

async function main() {
  console.log('=== Square Bookings 同期 ===')
  console.log(`モード            : ${DRY_RUN ? '🟡 DRY RUN（書き込みなし）' : '🔴 本番実行（書き込みあり）'}`)
  console.log(`Square 環境       : ${SQUARE_ENV}`)
  console.log(`Location ID       : ${SQUARE_LOCATION_ID}`)
  console.log(`salonCompanyName  : ${SALON_COMPANY_NAME}`)
  console.log(`OPERATOR          : ${OPERATOR}`)
  console.log(`取得期間          : ${START_AT_MIN.toISOString()} 〜 ${START_AT_MAX.toISOString()}`)
  console.log('')

  // 1. Square から予約取得
  console.log('▶ Square Bookings 取得中...')
  let bookings = []
  try {
    bookings = await fetchAllBookings()
  } catch (e) {
    console.error('❌ Square API 取得失敗:', e.message)
    process.exit(1)
  }
  console.log(`  取得: ${bookings.length} 件`)
  console.log('')

  // 2. 各予約を reservations に upsert
  let created = 0
  let updated = 0
  let skipped = 0
  const failedEntries = []

  for (const booking of bookings) {
    try {
      // 顧客情報は詳細取得（任意）
      const customer = booking.customer_id ? await fetchCustomer(booking.customer_id) : null
      const docData = buildReservationDoc(booking, customer)
      const docId = reservationDocId(docData.externalId)
      const docRef = db.collection(RESERVATIONS_COLLECTION).doc(docId)

      if (DRY_RUN) {
        skipped += 1
        continue
      }

      // 既存確認（create / updated カウント用）
      const snap = await docRef.get()
      if (snap.exists) {
        await docRef.set(docData, { merge: true })
        updated += 1
      } else {
        await docRef.set(
          { ...docData, createdAt: FieldValue.serverTimestamp() },
          { merge: true },
        )
        created += 1
      }
    } catch (e) {
      failedEntries.push({
        externalId: booking?.id || '(unknown)',
        reason: e.message || String(e),
      })
    }
  }

  // 3. サマリ表示
  console.log('=== 集計結果 ===')
  console.log(`取得           : ${bookings.length}`)
  console.log(`新規作成       : ${created}`)
  console.log(`更新           : ${updated}`)
  console.log(`スキップ(DRY)  : ${skipped}`)
  console.log(`失敗           : ${failedEntries.length}`)
  if (failedEntries.length > 0) {
    console.log('--- 失敗サンプル（最大5件） ---')
    for (const f of failedEntries.slice(0, 5)) {
      console.log(`  ${f.externalId}: ${f.reason}`)
    }
  }
  console.log('')

  // 4. 監査ログ保存
  await writeAuditLog({
    mode: DRY_RUN ? 'dry-run' : 'production',
    results: {
      fetched: bookings.length,
      created,
      updated,
      skipped,
      failed: failedEntries.length,
    },
    failedEntries,
    period: {
      startAtMin: START_AT_MIN.toISOString(),
      startAtMax: START_AT_MAX.toISOString(),
    },
  })

  if (DRY_RUN) {
    console.log('🟡 DRY RUN モードでした。実際には書き込んでいません。')
    console.log('   本番実行は: DRY_RUN=false node scripts/sync-square-bookings.mjs')
  } else {
    console.log(`🟢 本番実行完了: 新規 ${created} / 更新 ${updated} / 失敗 ${failedEntries.length}`)
  }

  process.exit(0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
