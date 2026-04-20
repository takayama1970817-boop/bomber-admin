/**
 * ci-dryrun.mjs
 *
 * GitHub Actions workflow_dispatch から起動する dryRun 検証スクリプト。
 *
 * 使い方:
 *   node scripts/ci-dryrun.mjs <functionName> [targetMonth]
 *
 * 例:
 *   node scripts/ci-dryrun.mjs createMonthlySettlement 2026-03
 *   node scripts/ci-dryrun.mjs detectDuplicates
 *
 * 認証:
 *   GOOGLE_APPLICATION_CREDENTIALS が指す JSON ファイルのサービスアカウントを使う。
 *   GitHub Actions 側で google-github-actions/auth@v2 が自動でセットする。
 *
 * 重要:
 *   - createMonthlySettlement は dryRun: true 固定で呼ぶ（本番書き込み禁止）
 *   - detectDuplicates は読み取り専用走査なのでそのまま呼ぶ
 *     （ただし settlementDuplicateChecks への走査結果記録は発生する）
 *   - プロジェクトは ADC（Application Default Credentials）から自動判定
 *     CI 側で FIREBASE_SERVICE_ACCOUNT を test 用に設定することで安全性を担保
 *
 * 出力:
 *   - 標準出力に JSON サマリ
 *   - GitHub Actions の GITHUB_STEP_SUMMARY にマークダウン表
 */

import { appendFileSync, writeFileSync, existsSync } from 'fs'
import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// =====================================================================
// 引数解析
// =====================================================================

const ALLOWED_FUNCTIONS = Object.freeze([
  'createMonthlySettlement',
  'detectDuplicates',
])

const functionName = process.argv[2]
const targetMonth = process.argv[3] || null

if (!functionName) {
  console.error('Usage: node scripts/ci-dryrun.mjs <functionName> [targetMonth]')
  console.error(`  functionName: one of [${ALLOWED_FUNCTIONS.join(', ')}]`)
  process.exit(1)
}
if (!ALLOWED_FUNCTIONS.includes(functionName)) {
  console.error(`Invalid function: ${functionName}`)
  console.error(`Allowed: [${ALLOWED_FUNCTIONS.join(', ')}]`)
  process.exit(1)
}

// =====================================================================
// Admin SDK 初期化
// =====================================================================

if (getApps().length === 0) {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credPath && existsSync(credPath)) {
    // CI からは JSON パスが入る
    initializeApp({ credential: applicationDefault() })
  } else {
    // ローカル実行時の保険: scripts/service-account.json
    try {
      const { readFileSync } = await import('fs')
      const sa = JSON.parse(readFileSync('scripts/service-account.json', 'utf8'))
      initializeApp({ credential: cert(sa) })
    } catch (err) {
      console.error('❌ 認証情報が見つかりません。')
      console.error('   GOOGLE_APPLICATION_CREDENTIALS か scripts/service-account.json が必要です。')
      console.error(err && err.message ? err.message : err)
      process.exit(1)
    }
  }
}

const db = getFirestore()

// =====================================================================
// 実行本体
// =====================================================================

async function runCreateMonthlySettlement() {
  // Cloud Functions の内部関数を直接 require すると Functions 側の
  // firebase-admin 初期化と競合するため、HTTPS callable ではなく
  // Admin SDK で同等処理を再実装する方針は取らない。
  // 代わりに「ドライラン相当の読み取り」を Admin SDK で行う：
  //   1. settings/settlement_automation の状態を確認
  //   2. dealers 一覧を取得
  //   3. kbGroup 分類と既存 docId 存在を報告
  //   4. 実際の create は行わない

  const settingsSnap = await db.doc('settings/settlement_automation').get()
  const enabled = settingsSnap.exists && settingsSnap.data().enabled === true

  const month = targetMonth || previousMonth()
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Invalid targetMonth: ${month}`)
  }

  const dealersSnap = await db.collection('dealers').where('active', '==', true).get()
  const dealers = dealersSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

  const willCreate = []
  const skipped = []
  for (const dealer of dealers) {
    const code = dealer.dealerCode || dealer.id
    if (!/^J\d{4}$/.test(code)) {
      skipped.push({ dealerCode: code, reason: 'invalid_dealerCode' })
      continue
    }
    let type = null
    if (dealer.kbGroup === 'A' || dealer.kbGroup === 'B') type = 'kb'
    else if (dealer.kbGroup === 'C') type = 'invoice'
    if (!type) {
      skipped.push({ dealerCode: code, reason: 'no_kbGroup' })
      continue
    }

    const collection = type === 'kb' ? 'kickbacks' : 'invoices'
    const docId = `${type}_${code}_${month}`
    const existing = await db.collection(collection).doc(docId).get()
    if (existing.exists) {
      skipped.push({ dealerCode: code, reason: 'already_exists', existingDocId: docId })
    } else {
      willCreate.push({ dealerCode: code, type, docId })
    }
  }

  return {
    functionName: 'createMonthlySettlement',
    mode: 'dryRun',
    enabled,
    targetMonth: month,
    targetDealerCount: dealers.length,
    willCreateCount: willCreate.length,
    skippedCount: skipped.length,
    willCreate,
    skipped,
    notes: enabled
      ? 'automation is enabled. 本番実行すると上記 willCreate が作成される。'
      : 'automation is DISABLED. 本番実行しても aborted 戻りになり何も作成しない。',
  }
}

async function runDetectDuplicates() {
  // detectDuplicates の dryRun 相当：走査だけ行い settlementDuplicateChecks には書かない
  const collections = ['kickbacks', 'invoices']
  let structuredCount = 0
  let legacyCount = 0
  const duplicates = []
  const byCollection = {}

  for (const col of collections) {
    const snap = await db.collection(col).get()
    byCollection[col] = { total: snap.size, structured: 0, legacy: 0 }

    const seen = new Map()
    for (const doc of snap.docs) {
      if (!/^(kb|invoice)_J\d{4}_\d{4}-(0[1-9]|1[0-2])$/.test(doc.id)) {
        legacyCount += 1
        byCollection[col].legacy += 1
        continue
      }
      structuredCount += 1
      byCollection[col].structured += 1

      const data = doc.data() || {}
      const key = `${data.dealerCode || ''}|${data.month || ''}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key).push(doc.id)
    }
    for (const [key, ids] of seen) {
      if (ids.length > 1) duplicates.push({ collection: col, key, docIds: ids })
    }
  }

  return {
    functionName: 'detectDuplicates',
    mode: 'dryRun',
    checkedCollections: collections,
    byCollection,
    structuredCount,
    legacyCount,
    duplicatesFound: duplicates.length,
    duplicates,
    notes: duplicates.length > 0
      ? '⚠️ 本番実行すると automation 停止 + adminNotifications(critical) が発火する'
      : '二重なし。本番実行しても停止は発火しない。',
  }
}

function previousMonth() {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// =====================================================================
// GitHub Step Summary 書き込み
// =====================================================================

function appendSummary(title, result) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return // ローカル実行時は書き込まない

  const md = [
    `# ${title}`,
    '',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
  ].join('\n')

  appendFileSync(summaryPath, md)
}

// =====================================================================
// main
// =====================================================================

async function main() {
  let result
  if (functionName === 'createMonthlySettlement') {
    result = await runCreateMonthlySettlement()
  } else if (functionName === 'detectDuplicates') {
    result = await runDetectDuplicates()
  }

  console.log(JSON.stringify(result, null, 2))
  appendSummary(`DryRun: ${functionName}`, result)
}

main().catch((err) => {
  console.error('❌ Error:', err && err.message ? err.message : err)
  console.error(err && err.stack ? err.stack : '')
  process.exit(1)
})
