/**
 * 既存 kickbacks ドキュメントへの phase / mailStatus バックフィル
 *
 * docs/KICKBACK_REQUIREMENTS.md §9 の推定ルール:
 *   phase 推定:
 *     - 既に phase が保存されていれば触らない
 *     - pdfUrl がある → 'pdf_ready'
 *     - totalKickback / grandTotal > 0 または entries 1件以上 → 'calculated'
 *     - それ以外 → 'calculating'
 *   mailStatus 推定:
 *     - 既に mailStatus が保存されていれば触らない
 *     - mailSentAt がある or 旧 status === 'sent' → 'sent'
 *     - それ以外 → 'unsent'
 *
 * ===== 認証方法（2 通りのうちどちらか） =====
 *
 * (A) サービスアカウント JSON を使う:
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *       node scripts/backfill-kickback-phase.mjs --project=bomber-admin --dry-run
 *
 * (B) Application Default Credentials を使う（推奨）:
 *     1) 一度だけ: gcloud auth application-default login
 *     2) 実行:    node scripts/backfill-kickback-phase.mjs --project=bomber-admin --dry-run
 *
 * ===== 安全ガード =====
 *
 *   --project=<id> は必須。指定しないとエラー終了。
 *   サービスアカウント JSON の project_id と --project が違うとエラー終了。
 *   --dry-run なら Firestore に一切書き込まない。
 *   既に phase / mailStatus が入っているドキュメントは触らない（idempotent）。
 *   本番反映前に件数とサンプル 5 件を表示し、5 秒待機して中断機会を提供。
 *
 * ===== 実行例 =====
 *
 *   # ドライラン（本番）
 *   node scripts/backfill-kickback-phase.mjs --project=bomber-admin --dry-run
 *
 *   # 本番反映
 *   node scripts/backfill-kickback-phase.mjs --project=bomber-admin
 *
 *   # ドライラン（テスト環境）
 *   node scripts/backfill-kickback-phase.mjs --project=bomber-admin-test --dry-run
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// ─────────────────────────────────────────────────────────
// 引数パース
// ─────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const projectArg = args.find((a) => a.startsWith('--project='))
const explicitProject = projectArg ? projectArg.split('=')[1] : null

if (!explicitProject) {
  console.error('❌ --project=<projectId> は必須です。')
  console.error('   例: node scripts/backfill-kickback-phase.mjs --project=bomber-admin --dry-run')
  console.error('')
  console.error('  本番:    --project=bomber-admin')
  console.error('  テスト:  --project=bomber-admin-test')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────
// 認証セットアップ
//   SERVICE_ACCOUNT_FILE が指定されていればその JSON を使う
//   無ければ Application Default Credentials（gcloud auth ADC）を使う
// ─────────────────────────────────────────────────────────
const saEnv = process.env.SERVICE_ACCOUNT_FILE
let authMode
let credentialProject

if (saEnv) {
  const saPath = resolve(process.cwd(), saEnv)
  if (!existsSync(saPath)) {
    console.error(`❌ SERVICE_ACCOUNT_FILE が見つかりません: ${saPath}`)
    process.exit(1)
  }
  const sa = JSON.parse(readFileSync(saPath, 'utf8'))
  credentialProject = sa.project_id
  authMode = `service-account (${saPath})`
  initializeApp({ credential: cert(sa), projectId: sa.project_id })
} else {
  // ADC (Application Default Credentials)
  // 事前に `gcloud auth application-default login` が必要
  authMode = 'application-default-credentials'
  credentialProject = process.env.GOOGLE_CLOUD_PROJECT || explicitProject
  try {
    initializeApp({ credential: applicationDefault(), projectId: explicitProject })
  } catch (e) {
    console.error('❌ Application Default Credentials の初期化に失敗:', e.message)
    console.error('   先に以下を実行してください:')
    console.error('     gcloud auth application-default login')
    process.exit(1)
  }
}

// ─────────────────────────────────────────────────────────
// プロジェクト一致ガード
//   サービスアカウント JSON の project_id と --project が違えば停止
//   ADC の場合は明示プロジェクトが GCP 側に存在するかは Firestore 接続時に判明
// ─────────────────────────────────────────────────────────
if (saEnv && credentialProject !== explicitProject) {
  console.error('❌ プロジェクトが一致しません。')
  console.error(`   サービスアカウント JSON の project_id: ${credentialProject}`)
  console.error(`   --project 引数:                       ${explicitProject}`)
  console.error('')
  console.error('  正しい組み合わせで再実行してください。')
  console.error(`  例: SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \\`)
  console.error(`        node scripts/backfill-kickback-phase.mjs --project=${credentialProject} --dry-run`)
  process.exit(1)
}

const db = getFirestore()

// ─────────────────────────────────────────────────────────
// 推定ロジック（src/lib/kickbackStatus.js と同じルール）
// ─────────────────────────────────────────────────────────
const PHASE = { CALCULATING: 'calculating', CALCULATED: 'calculated', PDF_READY: 'pdf_ready' }
const MAIL = { UNSENT: 'unsent', SENT: 'sent' }

function derivePhase(kb) {
  if (kb.phase) return null // 触らない
  if (kb.pdfUrl) return PHASE.PDF_READY
  const total = Number(kb.totalKickback ?? kb.grandTotal ?? 0)
  const hasEntries = Array.isArray(kb.entries) && kb.entries.length > 0
  if (total > 0 || hasEntries) return PHASE.CALCULATED
  return PHASE.CALCULATING
}

function deriveMailStatus(kb) {
  if (kb.mailStatus) return null
  if (kb.mailSentAt || kb.status === 'sent') return MAIL.SENT
  return MAIL.UNSENT
}

// ─────────────────────────────────────────────────────────
// 本体
// ─────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('[backfill-kickback-phase]')
  console.log(`  authMode:  ${authMode}`)
  console.log(`  project:   ${explicitProject}${explicitProject === 'bomber-admin' ? '  ⚠ 本番' : ''}`)
  console.log(`  dryRun:    ${dryRun}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const snap = await db.collection('kickbacks').get()
  console.log(`\n  total docs: ${snap.size}`)

  if (snap.size === 0) {
    console.log('\n⚠ kickbacks コレクションが 0 件です。')
    console.log('  - 認証先プロジェクトが正しいか再確認してください。')
    console.log(`  - 現在の指定: --project=${explicitProject}`)
    process.exit(0)
  }

  const plan = []
  for (const d of snap.docs) {
    const kb = d.data()
    const p = derivePhase(kb)
    const m = deriveMailStatus(kb)
    if (p == null && m == null) continue
    plan.push({
      id: d.id,
      dealerCode: kb.dealerCode || '',
      month: kb.month || '',
      legacyStatus: kb.status || null,
      hasPdfUrl: !!kb.pdfUrl,
      hasMailSentAt: !!kb.mailSentAt,
      newPhase: p,
      newMailStatus: m,
    })
  }

  console.log(`  docs to update:        ${plan.length}`)
  console.log(`  docs already migrated: ${snap.size - plan.length}`)

  if (plan.length === 0) {
    console.log('\n何も更新する対象がありません。終了します。')
    process.exit(0)
  }

  console.log('\nサンプル（先頭 5 件）:')
  for (const p of plan.slice(0, 5)) {
    console.log('  ', JSON.stringify(p))
  }

  if (dryRun) {
    console.log('\n--dry-run のため Firestore 書き込みは行いません。')
    process.exit(0)
  }

  console.log(`\n本番反映を 5 秒後に開始します（project=${explicitProject}、Ctrl+C で中断可）...`)
  await new Promise((r) => setTimeout(r, 5000))

  let touched = 0
  let failed = 0
  for (const p of plan) {
    try {
      const update = {}
      if (p.newPhase) update.phase = p.newPhase
      if (p.newMailStatus) update.mailStatus = p.newMailStatus
      await db.collection('kickbacks').doc(p.id).set(update, { merge: true })
      touched += 1
      if (touched % 20 === 0) console.log(`  ... ${touched}/${plan.length}`)
    } catch (e) {
      failed += 1
      console.warn(`  FAIL ${p.id}: ${e.message}`)
    }
  }

  console.log(`\n[backfill-kickback-phase] done. project=${explicitProject}, touched=${touched}, failed=${failed}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[backfill-kickback-phase] fatal:', e)
  process.exit(1)
})
