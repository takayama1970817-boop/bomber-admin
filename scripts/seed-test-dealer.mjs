/**
 * ⚠️  非推奨: このスクリプトは現在使用しません  ⚠️
 *
 * 方針変更（2026-04-19）:
 *   送信検証はダミー代理店ではなく「協力代理店1社（実在）」で実地テストする
 *   運用に切り替えた。このスクリプトは削除しないが、今回は実行しないこと。
 *
 *   協力代理店で検証する場合:
 *     - このスクリプトは使わず、既存の allowedEmails をそのまま使う
 *     - settings/rt_company.testDealerCode を協力代理店の実コードに設定する
 *       （Firestore Console から手動で設定、または別の専用スクリプトを用意）
 *     - seed-test-kickback.mjs は協力代理店向けに実行可能（TEST SEND 識別必須）
 *
 *   再利用するケース（参考）:
 *     - 協力代理店が見つからない環境で再度ダミー検証に戻す必要が生じた場合
 *
 * ---（以下、元のダミー代理店作成スクリプトの説明）---
 *
 * ダミーテスト代理店の作成スクリプト（Admin SDK）
 *
 * 目的:
 *   - 本番代理店と混同しないテスト専用の代理店を allowedEmails に1件作成する
 *   - 同じ dealerCode が既に存在する場合はスキップ（冪等）
 *   - settings/rt_company.testDealerCode にも同じコードをセットして、
 *     Functions 側 sendSettlementEmail の TEST_DEALER_CODE 検証と整合させる
 *
 * 設計方針:
 *   1. ドライラン既定   — 実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全       — 既に該当 dealerCode の doc があればスキップ
 *   3. 識別可能         — companyName 頭に「【テスト】」、isTest:true フラグ
 *
 * 使用方法:
 *   # ドライラン（既定）
 *   node scripts/seed-test-dealer.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false node scripts/seed-test-dealer.mjs
 *
 *   # 代理店コード・名称・宛先メール・kbGroup をカスタマイズ
 *   TEST_DEALER_CODE=TEST-DEALER-001 \
 *   TEST_DEALER_NAME='【テスト】送信確認代理店' \
 *   TEST_DEALER_EMAIL=takayama1970817@gmail.com \
 *   TEST_DEALER_KB_GROUP=A \
 *   DRY_RUN=false node scripts/seed-test-dealer.mjs
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
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}
const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'

const TEST_DEALER_CODE = process.env.TEST_DEALER_CODE || 'TEST-DEALER-001'
const TEST_DEALER_NAME = process.env.TEST_DEALER_NAME || '【テスト】送信確認代理店'
const TEST_DEALER_EMAIL = process.env.TEST_DEALER_EMAIL || ''
const TEST_DEALER_KB_GROUP = process.env.TEST_DEALER_KB_GROUP || 'A'

if (!TEST_DEALER_EMAIL) {
  console.error('❌ TEST_DEALER_EMAIL（受信確認できるテスト用メール）を指定してください')
  console.error('   例: TEST_DEALER_EMAIL=takayama1970817@gmail.com DRY_RUN=false node scripts/seed-test-dealer.mjs')
  process.exit(1)
}

async function run() {
  console.log('⚠️  このスクリプトは現在「非推奨」です（2026-04-19 方針変更）')
  console.log('   送信検証は協力代理店1社の実コードで実地テストする運用です。')
  console.log('   続行する場合は ACKNOWLEDGE_DEPRECATED=yes を指定してください。')
  console.log()
  if (process.env.ACKNOWLEDGE_DEPRECATED !== 'yes') {
    console.error('❌ ACKNOWLEDGE_DEPRECATED=yes が指定されていないため中断します')
    process.exit(1)
  }
  console.log('=== ダミーテスト代理店 作成スクリプト ===')
  console.log(`  DRY_RUN: ${DRY_RUN}`)
  console.log(`  dealerCode: ${TEST_DEALER_CODE}`)
  console.log(`  companyName: ${TEST_DEALER_NAME}`)
  console.log(`  email: ${TEST_DEALER_EMAIL}`)
  console.log(`  kbGroup: ${TEST_DEALER_KB_GROUP}`)
  console.log()

  // ① allowedEmails に既存があるかチェック
  const existing = await db.collection('allowedEmails')
    .where('dealerCode', '==', TEST_DEALER_CODE)
    .where('role', '==', 'dealer')
    .get()

  if (!existing.empty) {
    const doc = existing.docs[0]
    console.log(`✓ 既に登録済み（スキップ）: allowedEmails/${doc.id}`)
    console.log('  データ:', JSON.stringify(doc.data(), null, 2))
  } else {
    const payload = {
      email: TEST_DEALER_EMAIL,
      name: TEST_DEALER_NAME,
      companyName: TEST_DEALER_NAME,
      role: 'dealer',
      subRole: 'admin',
      dealerCode: TEST_DEALER_CODE,
      kbGroup: TEST_DEALER_KB_GROUP,
      active: true,
      isTest: true, // 集計・一覧で識別するための明示フラグ
      includeOwnOrders: false,
      invitedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (DRY_RUN) {
      console.log('[DRY_RUN] 以下を allowedEmails に作成予定:')
      console.log(JSON.stringify(payload, null, 2))
    } else {
      const ref = await db.collection('allowedEmails').add(payload)
      console.log(`✓ 作成完了: allowedEmails/${ref.id}`)
    }
  }

  // ② settings/rt_company.testDealerCode をセット
  const settingsRef = db.collection('settings').doc('rt_company')
  const settingsSnap = await settingsRef.get()
  const current = settingsSnap.exists ? settingsSnap.data().testDealerCode : null
  if (current === TEST_DEALER_CODE) {
    console.log(`✓ settings/rt_company.testDealerCode は既に ${TEST_DEALER_CODE}（スキップ）`)
  } else {
    if (DRY_RUN) {
      console.log(`[DRY_RUN] settings/rt_company.testDealerCode を "${current || '(未設定)'}" → "${TEST_DEALER_CODE}" に更新予定`)
    } else {
      await settingsRef.set(
        { testDealerCode: TEST_DEALER_CODE, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      console.log(`✓ settings/rt_company.testDealerCode を "${TEST_DEALER_CODE}" に更新`)
    }
  }

  console.log()
  console.log('=== 次にやること ===')
  console.log('  1. .env.local に VITE_TEST_DEALER_CODE=' + TEST_DEALER_CODE + ' を追記')
  console.log('  2. Functions 環境変数 TEST_DEALER_CODE=' + TEST_DEALER_CODE + ' を設定')
  console.log('     または settings/rt_company.testDealerCode を使う場合は ①のみでOK')
  console.log('  3. npm run build && firebase deploy（必要なら）')
  console.log('  4. node scripts/seed-test-kickback.mjs でダミー清算書を作成')

  process.exit(0)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
