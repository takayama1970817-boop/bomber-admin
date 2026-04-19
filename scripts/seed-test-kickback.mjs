/**
 * ダミーテスト清算書の作成スクリプト（Admin SDK）
 *
 * 目的:
 *   - 送信検証のためのダミー kickback ドキュメントを1件作成する
 *   - 同じ dealerCode + month の組み合わせが既にあればスキップ（冪等）
 *   - 金額は少額のダミー（¥1,000）で、監査上テストと分かるようにする
 *
 * 設計方針:
 *   1. ドライラン既定   — 実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全       — 既に該当 (dealerCode, month) の doc があればスキップ
 *   3. テスト明示       — isTest:true、memo に「TEST」文字列
 *
 * 前提:
 *   - 先に scripts/seed-test-dealer.mjs を実行してテスト代理店が作成済みであること
 *
 * 使用方法:
 *   # ドライラン（既定）
 *   node scripts/seed-test-kickback.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false node scripts/seed-test-kickback.mjs
 *
 *   # カスタム
 *   TEST_DEALER_CODE=TEST-DEALER-001 \
 *   TEST_MONTH=2026-04 \
 *   DRY_RUN=false node scripts/seed-test-kickback.mjs
 *
 * 必要な認証ファイル:
 *   scripts/service-account.json（Firebase Admin SDK 秘密鍵）
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)
if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  process.exit(1)
}
const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const TEST_DEALER_CODE = process.env.TEST_DEALER_CODE || 'TEST-DEALER-001'
const TEST_MONTH = process.env.TEST_MONTH || defaultMonth()

function defaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

async function run() {
  console.log('=== ダミーテスト清算書 作成スクリプト ===')
  console.log(`  DRY_RUN: ${DRY_RUN}`)
  console.log(`  dealerCode: ${TEST_DEALER_CODE}`)
  console.log(`  month: ${TEST_MONTH}`)
  console.log()

  // 代理店の存在確認
  const dealerSnap = await db.collection('allowedEmails')
    .where('dealerCode', '==', TEST_DEALER_CODE)
    .where('role', '==', 'dealer')
    .get()
  if (dealerSnap.empty) {
    console.error(`❌ 代理店が見つかりません: ${TEST_DEALER_CODE}`)
    console.error('   先に scripts/seed-test-dealer.mjs を実行してください')
    process.exit(1)
  }
  const dealer = dealerSnap.docs[0].data()
  console.log(`  → 代理店: ${dealer.companyName || dealer.name}`)

  // 既存チェック（同 dealerCode + month の kickback が1件でもあればスキップ）
  const existing = await db.collection('kickbacks')
    .where('dealerCode', '==', TEST_DEALER_CODE)
    .where('month', '==', TEST_MONTH)
    .get()
  if (!existing.empty) {
    console.log(`✓ 既に kickback が存在（スキップ）: ${existing.size}件`)
    for (const d of existing.docs) {
      console.log(`  - kickbacks/${d.id}  (${d.data().source || 'unknown'})`)
    }
    console.log()
    console.log('  → このうち1件を KickbackManage 画面で「📮 SES送信」してください')
    process.exit(0)
  }

  // ダミー清算書の構造（KickbackManage.jsx の addDoc ペイロードに合わせた最小セット）
  const payload = {
    dealerCode: TEST_DEALER_CODE,
    dealerName: dealer.companyName || dealer.name || TEST_DEALER_CODE,
    month: TEST_MONTH,
    entries: [
      {
        salonName: '【テスト】ダミーサロン',
        type: 'sub',
        orderCount: 1,
        orderTotal: 1000,
        kickbackAmount: 1000,
      },
    ],
    totalKickback: 1000,
    totalSales: 1000,
    paperBagTotal: 0,
    systemFee: 0,
    kbOrderCount: 0,
    paymentFee: 0,
    creditCount: 0,
    subtotalAfterDeductions: 1000,
    tax: 100,
    grandTotal: 1100,
    dealerOrderSubtotal: 0,
    dealerOrderTax: 0,
    dealerOrderTotal: 0,
    dealerOrderCount: 0,
    dealerOrderItems: [],
    netSettlement: 1100,
    adjustments: [],
    adjustmentTotal: 0,
    finalSettlement: 1100,
    stampDataUrl: null,
    companyInfo: null,
    bankInfo: dealer.bankInfo || null,
    source: 'test-seed',
    isTest: true,
    memo: 'TEST: ダミー清算書（seed-test-kickback.mjs により作成）',
    createdAt: FieldValue.serverTimestamp(),
  }

  if (DRY_RUN) {
    console.log('[DRY_RUN] 以下を kickbacks に作成予定:')
    console.log(JSON.stringify({ ...payload, createdAt: '<serverTimestamp>' }, null, 2))
  } else {
    const ref = await db.collection('kickbacks').add(payload)
    console.log(`✓ 作成完了: kickbacks/${ref.id}`)
    console.log()
    console.log('=== 次にやること ===')
    console.log(`  /admin/kickbacks を開き、代理店 "${TEST_DEALER_CODE}" を選択`)
    console.log(`  → ${TEST_MONTH} の清算書に「📮 SES送信」ボタンが表示されることを確認`)
  }
  process.exit(0)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
