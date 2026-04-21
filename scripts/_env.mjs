/**
 * scripts/ 配下の Node スクリプト用 環境変数ヘルパー。
 *
 * - 起動時に `.env.local`（無ければ `.env`）を自動ロードする。
 * - 必須値が欠けている場合は、どの env がどのファイルに必要かを示して exit する。
 * - 秘密情報をコードにハードコードしないことを目的とする（コミット禁止対象）。
 *
 * 実行例:
 *   node scripts/bcart-sync.mjs
 *   node --env-file=.env.local scripts/bcart-sync.mjs   ← 明示指定でもOK
 *
 * 必要な環境変数:
 *   VITE_FIREBASE_API_KEY
 *   VITE_FIREBASE_AUTH_DOMAIN
 *   VITE_FIREBASE_PROJECT_ID
 *   VITE_FIREBASE_STORAGE_BUCKET
 *   VITE_FIREBASE_MESSAGING_SENDER_ID
 *   VITE_FIREBASE_APP_ID
 *   VITE_BCART_API_TOKEN          (Bカート同期スクリプトのみ)
 *   SCRIPT_FIREBASE_EMAIL         (Firestore に書き込むサービスアカウント email)
 *   SCRIPT_FIREBASE_PASSWORD      (同 password)
 *
 * オプション:
 *   BCART_BASE                    (既定: https://api.bcart.jp/api/v1)
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// .env.local を優先して自動ロード（Node 22+ の組み込み API）
function autoLoadEnvFile() {
  if (typeof process.loadEnvFile !== 'function') return
  for (const candidate of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), candidate)
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path)
      } catch (err) {
        console.error(`[env] failed to load ${candidate}: ${err?.message ?? err}`)
      }
      return
    }
  }
}
autoLoadEnvFile()

function need(name) {
  const v = process.env[name]
  if (v == null || v === '') {
    console.error(
      `\n[env] 環境変数 ${name} が未設定です。\n` +
        `      .env.local に値を追加するか、--env-file=PATH を指定してください。\n` +
        `      テンプレ: .env.local.example を参照\n`,
    )
    process.exit(1)
  }
  return v
}

/** Firebase Web SDK 用の firebaseConfig を返す（毎回チェック）。 */
export function getFirebaseConfig() {
  return {
    apiKey: need('VITE_FIREBASE_API_KEY'),
    authDomain: need('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: need('VITE_FIREBASE_PROJECT_ID'),
    storageBucket: need('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: need('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    appId: need('VITE_FIREBASE_APP_ID'),
  }
}

/** Firestore 書き込み用のサービスアカウント認証情報を返す。 */
export function getScriptCredentials() {
  return {
    email: need('SCRIPT_FIREBASE_EMAIL'),
    password: need('SCRIPT_FIREBASE_PASSWORD'),
  }
}

/** 倉庫アカウント（products 書き込み権限）認証情報を返す。 */
export function getWarehouseCredentials() {
  return {
    email: need('WAREHOUSE_FIREBASE_EMAIL'),
    password: need('WAREHOUSE_FIREBASE_PASSWORD'),
  }
}

/** Bカート API のアクセストークンを返す（Bカート系スクリプトのみで呼ぶこと）。 */
export function getBcartToken() {
  return need('VITE_BCART_API_TOKEN')
}

export const BCART_BASE = process.env.BCART_BASE || 'https://api.bcart.jp/api/v1'

/**
 * Admin SDK 用 service account を読み込み、本番 projectId と一致するかを検証する。
 *
 * 環境変数:
 *   SERVICE_ACCOUNT_PATH  scripts/ からの相対パス（既定: service-account.json）
 *                          例: SERVICE_ACCOUNT_PATH=service-account.prod.json
 *   EXPECTED_PROJECT_ID   想定 projectId（既定: bomber-admin）
 *                          test 環境を意図的に使うときは
 *                          EXPECTED_PROJECT_ID=bomber-admin-test
 *                          を明示する。
 *
 * 戻り値:
 *   { serviceAccount, projectId, credentialPath }
 *
 * project 不一致の場合は明示的なエラーメッセージを出して exit する。
 * これにより test 用 service-account.json で本番想定スクリプトが動く事故を防ぐ。
 */
export function loadAdminCredential(scriptsDir) {
  const fileName = process.env.SERVICE_ACCOUNT_PATH || 'service-account.json'
  // scriptsDir は呼び出し側から import.meta.url の dir を渡してもらう想定
  const credentialPath = resolve(scriptsDir, fileName)

  if (!existsSync(credentialPath)) {
    console.error(`\n❌ service account ファイルが見つかりません: ${credentialPath}`)
    console.error('   Firebase Console → プロジェクト設定 → サービスアカウント')
    console.error('   → 新しい秘密鍵 を取得して保存してください。')
    process.exit(1)
  }

  let serviceAccount
  try {
    serviceAccount = JSON.parse(readFileSync(credentialPath, 'utf8'))
  } catch (e) {
    console.error(`\n❌ service account JSON の読み込みに失敗: ${e.message}`)
    process.exit(1)
  }

  const projectId = serviceAccount.project_id || ''
  const expected = process.env.EXPECTED_PROJECT_ID || 'bomber-admin'

  if (projectId !== expected) {
    console.error('\n❌ Firebase project ID が想定と一致しません')
    console.error(`   service-account.json の projectId : ${projectId || '(空)'}`)
    console.error(`   client_email                       : ${serviceAccount.client_email || '(空)'}`)
    console.error(`   ファイルパス                        : ${credentialPath}`)
    console.error(`   期待値 (EXPECTED_PROJECT_ID)        : ${expected}`)
    console.error('')
    console.error('対応:')
    console.error(`   A) 本番 ('${expected}') の service account に差し替える:`)
    console.error(`      Firebase Console → ${expected} → プロジェクト設定 → サービスアカウント`)
    console.error('      → 新しい秘密鍵 を取得 → scripts/service-account.json として保存')
    console.error('')
    console.error('   B) 別ファイル名で保管している場合は env で指定:')
    console.error('      $env:SERVICE_ACCOUNT_PATH="service-account.prod.json"')
    console.error('      node scripts/...')
    console.error('')
    console.error(`   C) 意図的に '${projectId}' を使うなら以下を明示:`)
    console.error(`      $env:EXPECTED_PROJECT_ID="${projectId}"`)
    console.error('      node scripts/...')
    process.exit(1)
  }

  return { serviceAccount, projectId, credentialPath }
}
