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

import { existsSync } from 'node:fs'
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
