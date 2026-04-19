/**
 * テスト送信用清算書の作成スクリプト（Admin SDK）
 *
 * 方針変更（2026-04-19）:
 *   送信検証は「協力代理店1社（実在）」で実地テストする運用。
 *   このスクリプトは協力代理店向けに**テスト送信用**の清算書を1件作成する。
 *   実データと混ざらないよう、memo に必ず 'TEST SEND' を残し、金額は小さく固定する。
 *
 * 目的:
 *   - 協力代理店の実 dealerCode で、送信フロー検証用の kickback を1件作る
 *   - 同じ dealerCode + month + TEST SEND の組み合わせが既にあればスキップ（冪等）
 *   - 金額は固定の少額（¥1,100 税込）で監査上テストと分かるようにする
 *
 * 設計方針:
 *   1. ドライラン既定   — 実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全       — 同 (dealerCode, month, isTest:true) の doc があればスキップ
 *   3. テスト明示       — isTest:true、source:'test-seed'、memo 冒頭に 'TEST SEND'
 *
 * 前提:
 *   - 協力代理店が既に allowedEmails に登録済み
 *   - settings/rt_company.testDealerCode が協力代理店コードに設定済み
 *   - 協力代理店側に「これはテスト送信」である旨を事前共有済み
 *
 * 使用方法:
 *   # ドライラン（既定）
 *   TEST_DEALER_CODE=<協力代理店の実コード> \
 *     node scripts/seed-test-kickback.mjs
 *
 *   # 本番実行
 *   TEST_DEALER_CODE=<協力代理店の実コード> \
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
const TEST_DEALER_CODE = process.env.TEST_DEALER_CODE || ''
const TEST_MONTH = process.env.TEST_MONTH || defaultMonth()

if (!TEST_DEALER_CODE) {
  console.error('❌ TEST_DEALER_CODE（協力代理店の実 dealerCode）を指定してください')
  console.error('   例: TEST_DEALER_CODE=DLR001 DRY_RUN=false node scripts/seed-test-kickback.mjs')
  process.exit(1)
}

function defaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

async function run() {
  console.log('=== テスト送信用 清算書 作成スクリプト ===')
  console.log(`  DRY_RUN: ${DRY_RUN}`)
  console.log(`  dealerCode: ${TEST_DEALER_CODE}`)
  console.log(`  month: ${TEST_MONTH}`)
  console.log()

  // 代理店の存在確認（協力代理店は既に allowedEmails に登録済みの前提）
  const dealerSnap = await db.collection('allowedEmails')
    .where('dealerCode', '==', TEST_DEALER_CODE)
    .where('role', '==', 'dealer')
    .get()
  if (dealerSnap.empty) {
    console.error(`❌ 代理店が見つかりません: ${TEST_DEALER_CODE}`)
    console.error('   協力代理店の dealerCode が正しいか、allowedEmails に登録済みか確認してください')
    process.exit(1)
  }
  const dealer = dealerSnap.docs[0].data()
  console.log(`  → 代理店: ${dealer.companyName || dealer.name}`)

  // 既存チェック（同 dealerCode + month + isTest:true の kickback が1件でもあればスキップ）
  // 実データの清算書（isTest=false/undefined）は別物なのでスキップ判定に含めない
  const existing = await db.collection('kickbacks')
    .where('dealerCode', '==', TEST_DEALER_CODE)
    .where('month', '==', TEST_MONTH)
    .where('isTest', '==', true)
    .get()
  if (!existing.empty) {
    console.log(`✓ 既にテスト送信用 kickback が存在（スキップ）: ${existing.size}件`)
    for (const d of existing.docs) {
      console.log(`  - kickbacks/${d.id}  (${d.data().source || 'unknown'}, memo: ${d.data().memo || ''})`)
    }
    console.log()
    console.log('  → この kickback を KickbackManage 画面で「📮 SES送信」してください')
    process.exit(0)
  }

  // テスト送信用清算書（KickbackManage.jsx の addDoc ペイロードに合わせた最小セット）
  // 協力代理店の実データと誤認しないよう、isTest:true + memo 冒頭 'TEST SEND' で識別
  const payload = {
    dealerCode: TEST_DEALER_CODE,
    dealerName: dealer.companyName || dealer.name || TEST_DEALER_CODE,
    month: TEST_MONTH,
    entries: [
      {
        salonName: '【TEST SEND】検証用ダミーサロン',
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
    memo: `TEST SEND: 協力代理店 ${TEST_DEALER_CODE} 向け検証用清算書（${TEST_MONTH}、固定 ¥1,100、seed-test-kickback.mjs 生成）`,
    note: 'TEST SEND',
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
