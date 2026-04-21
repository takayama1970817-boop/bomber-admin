/**
 * 代理店アカウント（allowedEmails）不足分 自動登録スクリプト
 *
 * 背景:
 *   V→J 代理店コード変更後、新 Jコード (J0016,J0017,J0018,J0020,J0021,J0022) が
 *   allowedEmails に未登録だった。これが原因で rebuild-dealer-salons が
 *   J0019 1社しか拾えない状態。まず allowedEmails を揃えてから rebuild → aggregate 再実行。
 *
 * やること:
 *   - allowedEmails に role=dealer を作成（最小構成）
 *   - users/{uid} / Firebase Auth は本スクリプトでは触らない
 *     （代理店がログインするタイミングで /admin/dealers 画面から付与する想定）
 *
 * 環境変数:
 *   DRY_RUN             既定 true
 *   OPERATOR            監査ログ記録用（本番時推奨）
 *   TARGET_JCODES       カンマ区切り
 *                        既定: J0016,J0017,J0018,J0020,J0021,J0022
 *   DEALER_EMAIL_MAP    JSON 文字列で email を明示指定
 *                        例: '{"J0016":"a@b.com","J0017":"c@d.com"}'
 *   DEALER_COMPANY_MAP  JSON 文字列で companyName を上書き（省略時は既定 + Bcart から解決）
 *   ALLOW_PLACEHOLDER   既定 false。true ならメール未提供時に
 *                        `{dealerCode}@{PLACEHOLDER_DOMAIN}` を使う
 *   PLACEHOLDER_DOMAIN  既定 'placeholder.bomber-admin.local'
 *   SUBROLE             既定 'admin'（dealer の subRole は必須）
 *   SERVICE_ACCOUNT_PATH / EXPECTED_PROJECT_ID は _env.mjs の仕様に従う
 *
 * 出力:
 *   - 標準出力: 計画サマリ + 代理店別行
 *   - scripts/logs/register-missing-dealers-<ts>.json
 *   - 本番時: dealerRegistrationLogs/{auto-id} に監査ログ
 *
 * 使用例:
 *   # dry-run（email 不足でも計画だけ出す）
 *   node scripts/register-missing-dealers.mjs
 *
 *   # 実 email を指定して本番
 *   $env:DEALER_EMAIL_MAP='{"J0016":"...","J0017":"...","J0018":"...","J0020":"...","J0021":"...","J0022":"..."}'
 *   $env:DRY_RUN="false"; $env:OPERATOR="社長 ボンバー"
 *   node scripts/register-missing-dealers.mjs
 *
 *   # placeholder 許容で本番（後で /admin/dealers から編集する前提）
 *   $env:ALLOW_PLACEHOLDER="true"
 *   $env:DRY_RUN="false"; $env:OPERATOR="社長 ボンバー"
 *   node scripts/register-missing-dealers.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken, loadAdminCredential } from './_env.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const { serviceAccount, projectId, credentialPath } = loadAdminCredential(SCRIPTS_DIR)
initializeApp({ credential: cert(serviceAccount), projectId })
const db = getFirestore()

const BCART_TOKEN = getBcartToken()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const ALLOW_PLACEHOLDER = process.env.ALLOW_PLACEHOLDER === 'true'
const PLACEHOLDER_DOMAIN = process.env.PLACEHOLDER_DOMAIN || 'placeholder.bomber-admin.local'
const SUBROLE = process.env.SUBROLE || 'admin'

const TARGET_JCODES = (process.env.TARGET_JCODES || 'J0016,J0017,J0018,J0020,J0021,J0022')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// 既知の社名マッピング（社長提供。env で上書き可能）
const DEFAULT_COMPANY_MAP = {
  J0016: 'Anthurium',
  J0017: 'T♡SALON',
  J0018: 'Realise total salon',
  J0019: 'mahalo',
  J0020: 'エステ処 麗らか',
  J0021: 'N_selection',
  J0022: 'Mimi Esthetics',
}
let envCompanyMap = {}
if (process.env.DEALER_COMPANY_MAP) {
  try {
    envCompanyMap = JSON.parse(process.env.DEALER_COMPANY_MAP)
  } catch (e) {
    console.error('❌ DEALER_COMPANY_MAP が JSON として不正:', e.message)
    process.exit(1)
  }
}
const DEALER_COMPANY_MAP = { ...DEFAULT_COMPANY_MAP, ...envCompanyMap }

let DEALER_EMAIL_MAP = {}
if (process.env.DEALER_EMAIL_MAP) {
  try {
    DEALER_EMAIL_MAP = JSON.parse(process.env.DEALER_EMAIL_MAP)
  } catch (e) {
    console.error('❌ DEALER_EMAIL_MAP が JSON として不正:', e.message)
    process.exit(1)
  }
}

const BCART_PAGE = 100
const BATCH_SIZE = 400
const LOGS_DIR = `${SCRIPTS_DIR}/logs`

// ========================================
// Bcart API
// ========================================
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
    if (!res.ok) throw new Error(`Bカート API error: ${res.status} ${res.statusText}`)
    return res.json()
  }
  throw new Error('Bカート レート制限継続中')
}

async function fetchAllBcartCustomers() {
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('customers', { limit: BCART_PAGE, offset })
    const items = data.customers || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    process.stdout.write(`\r  Bカート 会員: ${all.length}/${total} 件`)
    if (all.length >= total) break
    offset += BCART_PAGE
  }
  process.stdout.write('\n')
  return all
}

// ========================================
// main
// ========================================
async function main() {
  console.log('=== 代理店アカウント (allowedEmails) 自動登録 ===')
  console.log(`モード       : ${DRY_RUN ? '🟡 DRY RUN' : '🔴 本番実行'}`)
  console.log(`OPERATOR     : ${OPERATOR}`)
  console.log(`credential   : ${credentialPath}`)
  console.log(`projectId    : ${projectId}`)
  console.log(`対象Jコード  : ${TARGET_JCODES.join(', ')}`)
  console.log(`email 指定数 : ${Object.keys(DEALER_EMAIL_MAP).length}`)
  console.log(`placeholder  : ${ALLOW_PLACEHOLDER ? 'allow' : 'deny'}`)
  console.log(`subRole      : ${SUBROLE}`)
  console.log('')

  // 1. 既存 allowedEmails
  console.log('▶ 既存 allowedEmails 取得...')
  const existingSnap = await db.collection('allowedEmails').get()
  const existingByCode = new Map()
  existingSnap.forEach((d) => {
    const data = d.data()
    const code = String(data.dealerCode || '').trim()
    if (code) existingByCode.set(code, { docId: d.id, data })
  })
  console.log(`  allowedEmails 総件数: ${existingSnap.size} 件（dealerCode 付き: ${existingByCode.size} 社）`)
  console.log('')

  // 2. Bcart customers
  console.log('▶ Bカート customers 取得...')
  const customers = await fetchAllBcartCustomers()
  console.log(`  総会員数: ${customers.length} 件`)
  // id / member_code / code 等どのフィールドが J コードに相当するか不明なので
  // 複数候補をキーにマップ化する
  const bcartLookup = new Map()
  for (const c of customers) {
    for (const k of ['id', 'member_code', 'memberCode', 'code', 'customer_code']) {
      const v = String(c[k] ?? '').trim()
      if (v) bcartLookup.set(v, c)
    }
  }
  console.log('')

  // 3. Plan
  const toCreate = []
  const toSkipExists = []
  const missingEmail = []
  const warnings = []

  for (const code of TARGET_JCODES) {
    if (existingByCode.has(code)) {
      toSkipExists.push({
        dealerCode: code,
        docId: existingByCode.get(code).docId,
        existingEmail: existingByCode.get(code).data.email || '(unknown)',
      })
      continue
    }

    const bcartCustomer = bcartLookup.get(code) || null
    const bcartCompany = bcartCustomer
      ? (bcartCustomer.comp_name || bcartCustomer.customer_comp_name || bcartCustomer.name || '').trim()
      : ''
    const bcartEmail = bcartCustomer ? (bcartCustomer.email || bcartCustomer.customer_email || '').trim() : ''

    // email 決定
    let email = (DEALER_EMAIL_MAP[code] || '').trim()
    let emailSource = 'DEALER_EMAIL_MAP'
    if (!email) {
      email = bcartEmail
      emailSource = email ? 'bcart customer.email' : ''
    }
    if (!email) {
      if (ALLOW_PLACEHOLDER) {
        email = `${code.toLowerCase()}@${PLACEHOLDER_DOMAIN}`
        emailSource = 'placeholder'
      } else {
        missingEmail.push({
          dealerCode: code,
          companyName: DEALER_COMPANY_MAP[code] || bcartCompany || '',
          bcartCustomerFound: !!bcartCustomer,
          bcartEmailEmpty: !!bcartCustomer,
        })
        continue
      }
    }

    // companyName 決定
    const fallbackCompany = (DEALER_COMPANY_MAP[code] || '').trim()
    const companyName = fallbackCompany || bcartCompany || ''
    if (!companyName) {
      warnings.push({ dealerCode: code, reason: 'companyName を解決できず（空で登録）' })
    } else if (fallbackCompany && bcartCompany && fallbackCompany !== bcartCompany) {
      warnings.push({
        dealerCode: code,
        reason: `companyName 不一致: MAP='${fallbackCompany}' / Bcart='${bcartCompany}' → MAP を採用`,
      })
    }

    toCreate.push({
      dealerCode: code,
      email,
      emailSource,
      companyName,
      subRole: SUBROLE,
      bcartCustomerId: bcartCustomer ? String(bcartCustomer.id || '') : null,
    })
  }

  // 4. Summary
  console.log('=== 計画 ===')
  console.log(`作成予定   : ${toCreate.length} 件`)
  console.log(`既存で skip: ${toSkipExists.length} 件`)
  console.log(`email 不足 : ${missingEmail.length} 件`)
  console.log(`警告       : ${warnings.length} 件`)
  console.log('')

  if (toCreate.length > 0) {
    console.log('--- 作成予定 ---')
    for (const t of toCreate) {
      console.log(
        `  ✅ ${t.dealerCode} ${t.companyName.padEnd(26)} email=${t.email} (${t.emailSource}) subRole=${t.subRole}`,
      )
    }
    console.log('')
  }
  if (toSkipExists.length > 0) {
    console.log('--- 既存（skip）---')
    for (const s of toSkipExists) {
      console.log(`  ℹ️ ${s.dealerCode} docId=${s.docId} email=${s.existingEmail}`)
    }
    console.log('')
  }
  if (missingEmail.length > 0) {
    console.log('--- email 不足 ---')
    for (const m of missingEmail) {
      console.log(
        `  ⚠️ ${m.dealerCode} ${m.companyName} (Bcart customer ${m.bcartCustomerFound ? 'found・email 空' : '未発見'})`,
      )
    }
    console.log('')
  }
  if (warnings.length > 0) {
    console.log('--- 警告 ---')
    for (const w of warnings) console.log(`  ⚠️ ${w.dealerCode}: ${w.reason}`)
    console.log('')
  }

  // 5. Save JSON log
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = `${LOGS_DIR}/register-missing-dealers-${ts}.json`
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        dryRun: DRY_RUN,
        operator: OPERATOR,
        projectId,
        targetJCodes: TARGET_JCODES,
        allowPlaceholder: ALLOW_PLACEHOLDER,
        subRole: SUBROLE,
        dealerCompanyMap: DEALER_COMPANY_MAP,
        dealerEmailMapKeys: Object.keys(DEALER_EMAIL_MAP),
        summary: {
          create: toCreate.length,
          skip: toSkipExists.length,
          missingEmail: missingEmail.length,
          warnings: warnings.length,
        },
        toCreate,
        toSkipExists,
        missingEmail,
        warnings,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`📁 詳細ログ: ${logFile}`)
  console.log('')

  if (DRY_RUN) {
    console.log('🟡 DRY RUN のため書き込みはしていません。')
    if (missingEmail.length > 0) {
      console.log('')
      console.log('⚠️ 本番実行前に email の扱いを決めてください:')
      console.log('   A) 実アドレスを指定（推奨）:')
      const sample = missingEmail.map((m) => `"${m.dealerCode}":"example@...`).join(',')
      console.log(`      $env:DEALER_EMAIL_MAP='{${sample}}'`)
      console.log('')
      console.log('   B) placeholder を使う（後で /admin/dealers から編集）:')
      console.log('      $env:ALLOW_PLACEHOLDER="true"')
    }
    return
  }

  if (missingEmail.length > 0) {
    console.error('❌ email 不足のため本番書き込みを中止しました。')
    console.error('   DRY_RUN=true で再実行して対応方法を確認してください。')
    process.exit(1)
  }

  // 6. allowedEmails 書き込み
  console.log(`▶ allowedEmails 書き込み: ${toCreate.length} 件`)
  const writeErrors = []
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const chunk = toCreate.slice(i, i + BATCH_SIZE)
    const batch = db.batch()
    for (const t of chunk) {
      const ref = db.collection('allowedEmails').doc()
      batch.set(ref, {
        email: t.email,
        name: '',
        companyName: t.companyName,
        dealerCode: t.dealerCode,
        role: 'dealer',
        subRole: t.subRole,
        invitedAt: FieldValue.serverTimestamp(),
        loggedIn: false,
        source: 'register-missing-dealers.mjs',
        sourceBcartCustomerId: t.bcartCustomerId,
        note: `自動登録 by ${OPERATOR}（Firebase Auth / users/{uid} は別途 /admin/dealers 画面で付与）`,
      })
    }
    try {
      await batch.commit()
      console.log(`  ${i + chunk.length}/${toCreate.length}`)
    } catch (e) {
      chunk.forEach((t) => writeErrors.push({ dealerCode: t.dealerCode, error: e.message }))
      console.error(`  ❌ バッチ失敗 (${chunk.length} 件): ${e.message}`)
    }
  }

  // 7. 監査ログ
  try {
    const logRef = await db.collection('dealerRegistrationLogs').add({
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      projectId,
      targetJCodes: TARGET_JCODES,
      allowPlaceholder: ALLOW_PLACEHOLDER,
      subRole: SUBROLE,
      created: toCreate.length - writeErrors.length,
      skipped: toSkipExists.length,
      failed: writeErrors.length,
      entries: toCreate.map((t) => ({
        dealerCode: t.dealerCode,
        email: t.email,
        emailSource: t.emailSource,
        companyName: t.companyName,
      })),
      writeErrors,
      scriptVersion: '2026-04-21.v1',
    })
    console.log(`📝 監査ログ: dealerRegistrationLogs/${logRef.id}`)
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗:', e.message)
  }

  console.log('')
  console.log(`🟢 本番実行完了: allowedEmails ${toCreate.length - writeErrors.length} 件作成`)
  if (writeErrors.length > 0) {
    console.log(`⚠️  ${writeErrors.length} 件で書き込み失敗`)
  }
  console.log('')
  console.log('次の手順:')
  console.log(`  1) $env:TARGET_JCODES="${TARGET_JCODES.join(',')}"`)
  console.log(`  2) $env:DRY_RUN="false"; $env:OPERATOR="${OPERATOR}"`)
  console.log('  3) node scripts/rebuild-dealer-salons.mjs')
  console.log('  4) foreach ($c in @(' + TARGET_JCODES.map((c) => `'${c}'`).join(',') + ')) {')
  console.log('       $env:DEALER_CODE=$c; node scripts/aggregate-dealer-monthly.mjs')
  console.log('     }')
  console.log('     Remove-Item Env:DEALER_CODE')
  console.log('  5) /dealer, /dealer/orders, /dealer/salons で反映確認')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
