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
 * 実行方法:
 *   1) ドライラン（影響範囲確認、書き込み無し）:
 *      SERVICE_ACCOUNT_FILE=scripts/service-account.json node scripts/backfill-kickback-phase.mjs --dry-run
 *
 *   2) 本番反映:
 *      SERVICE_ACCOUNT_FILE=scripts/service-account.json node scripts/backfill-kickback-phase.mjs
 *
 * 安全対策:
 *   - --dry-run なら Firestore は一切変更しない
 *   - 既に phase / mailStatus が入っているドキュメントは触らない（idempotent）
 *   - 全件処理前に件数とサンプル 5 件を表示し、5 秒待機して中断機会を提供
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const saPath = resolve(process.cwd(), process.env.SERVICE_ACCOUNT_FILE || 'scripts/service-account.json')
const sa = JSON.parse(readFileSync(saPath, 'utf8'))
initializeApp({ credential: cert(sa), projectId: sa.project_id })
const db = getFirestore()

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

async function main() {
  console.log(`[backfill-kickback-phase] start dryRun=${dryRun}`)
  console.log(`  service account: ${saPath}`)
  console.log(`  project: ${sa.project_id}`)

  const snap = await db.collection('kickbacks').get()
  console.log(`\n  total docs: ${snap.size}`)

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

  console.log(`  docs to update: ${plan.length}`)
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

  console.log('\n本番反映を 5 秒後に開始します（Ctrl+C で中断）...')
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

  console.log(`\n[backfill-kickback-phase] done. touched=${touched}, failed=${failed}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[backfill-kickback-phase] fatal:', e)
  process.exit(1)
})
