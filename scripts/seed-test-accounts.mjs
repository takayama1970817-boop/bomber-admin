/**
 * テスト環境（bomber-admin-test）用のテストアカウント作成スクリプト
 *
 * 作成されるアカウント（全てメール/パスワードログイン）:
 *   1. admin（RT相当）         test-admin@example.com  / TestAdmin2026!
 *   2. dealer（D相当）         test-dealer@example.com / TestDealer2026!
 *   3. salon（S相当）          test-salon@example.com  / TestSalon2026!
 *
 * 処理内容:
 *   - Firebase Auth にメール/パスワードで createUser
 *   - allowedEmails にロール情報を登録（dealerCode / companyName / subRole 付き）
 *   - users ドキュメントは初回ログイン時に AuthContext が自動作成
 *
 * 使い方:
 *   1. Firebase Console（bomber-admin-test）→ プロジェクト設定 → サービスアカウント
 *      → 「新しい秘密鍵の生成」で JSON ダウンロード
 *   2. そのファイルを scripts/service-account-test.json として保存
 *   3. node scripts/seed-test-accounts.mjs
 *
 * 再実行安全:
 *   既に同じ email のアカウントが存在する場合はスキップ（作成エラーを無視）
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account-test.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account-test.json が見つかりません。')
  console.error('')
  console.error('   【取得手順】')
  console.error('   1. https://console.firebase.google.com/project/bomber-admin-test/settings/serviceaccounts/adminsdk')
  console.error('   2. 「新しい秘密鍵の生成」をクリック → JSON ダウンロード')
  console.error('   3. scripts/service-account-test.json として保存')
  console.error('   4. 再度このスクリプトを実行')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))

// 安全チェック：本番サービスアカウントを間違って置かないように project_id を検証
if (serviceAccount.project_id !== 'bomber-admin-test') {
  console.error(`❌ サービスアカウントのプロジェクトIDが不一致: ${serviceAccount.project_id}`)
  console.error('   bomber-admin-test のサービスアカウントを配置してください。')
  process.exit(1)
}

initializeApp({ credential: cert(serviceAccount) })
const auth = getAuth()
const db = getFirestore()

const TEST_ACCOUNTS = [
  {
    email: 'test-admin@example.com',
    password: 'TestAdmin2026!',
    displayName: 'テスト管理者',
    role: 'admin',
    // admin は subRole 不要
  },
  {
    email: 'test-dealer@example.com',
    password: 'TestDealer2026!',
    displayName: 'テスト代理店',
    role: 'dealer',
    subRole: 'admin',
    dealerCode: 'TEST_DEALER_001',
    companyName: 'テスト代理店株式会社',
  },
  {
    email: 'test-salon@example.com',
    password: 'TestSalon2026!',
    displayName: 'テストサロン',
    role: 'salon',
    subRole: 'admin',
    companyName: 'テストサロン株式会社',
    salonName: 'テストサロン',
  },
]

async function ensureAuthUser(account) {
  try {
    const existing = await auth.getUserByEmail(account.email)
    console.log(`  Auth: 既存 (${account.email}) uid=${existing.uid}`)
    // パスワードは更新しておく（忘れても復旧できるように）
    await auth.updateUser(existing.uid, { password: account.password, displayName: account.displayName })
    return existing.uid
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      const created = await auth.createUser({
        email: account.email,
        password: account.password,
        displayName: account.displayName,
        emailVerified: true,
      })
      console.log(`  Auth: 新規作成 (${account.email}) uid=${created.uid}`)
      return created.uid
    }
    throw e
  }
}

async function ensureAllowedEmail(account) {
  const snap = await db.collection('allowedEmails').where('email', '==', account.email).get()
  const payload = {
    email: account.email,
    name: account.displayName,
    role: account.role,
    ...(account.subRole ? { subRole: account.subRole } : {}),
    ...(account.dealerCode ? { dealerCode: account.dealerCode } : {}),
    ...(account.companyName ? { companyName: account.companyName } : {}),
    ...(account.salonName ? { salonName: account.salonName } : {}),
    invitedAt: FieldValue.serverTimestamp(),
    loggedIn: false,
  }
  if (snap.empty) {
    const ref = db.collection('allowedEmails').doc()
    await ref.set(payload)
    console.log(`  allowedEmails: 新規追加 (${account.email})`)
  } else {
    const d = snap.docs[0]
    // 既存レコードの role / subRole / コードを最新化
    await d.ref.set(payload, { merge: true })
    console.log(`  allowedEmails: 既存更新 (${account.email})`)
  }
}

async function main() {
  console.log('=== テストアカウント作成 (bomber-admin-test) ===')
  console.log('')

  for (const account of TEST_ACCOUNTS) {
    console.log(`▶ ${account.role}: ${account.email}`)
    await ensureAuthUser(account)
    await ensureAllowedEmail(account)
    console.log('')
  }

  console.log('=== 完了 ===')
  console.log('')
  console.log('以下のアカウントで https://bomber-admin-test.web.app にメール/パスワードログインできます:')
  console.log('')
  TEST_ACCOUNTS.forEach((a) => {
    console.log(`  [${a.role.toUpperCase()}] ${a.email} / ${a.password}`)
    if (a.dealerCode) console.log(`        dealerCode: ${a.dealerCode}`)
    if (a.companyName) console.log(`        companyName: ${a.companyName}`)
  })
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
