/**
 * allowedEmails への bcartParentId マッピング seed スクリプト（Admin SDK 版）
 *
 * 目的:
 *   既知マッピング 6 件（J0016=v1, J0017=v2, ..., J0021=v6）を
 *   allowedEmails コレクションの該当 dealer doc に bcartParentId を additive 追加する。
 *   PR γ（backfill）と PR δ（書き込み経路）が参照する真値となる。
 *
 * 絶対ルール:
 *   - 既定 DRY_RUN（DRY_RUN=false 明示時のみ書き込み）
 *   - bcartParentId フィールドのみ追加（dealerCode / role / 他は一切無触）
 *   - 既に bcartParentId が設定済みで値が異なる場合は警告のみ・上書きしない
 *   - dealerCode で対象 doc を特定（無ければスキップ + ログ）
 *   - audit log は orderBackfillLogs と分離: dealerMappingSeedLogs
 *
 * 既知マッピング（社長確認済み・2026-04-24）:
 *   J0016 ⇄ v1
 *   J0017 ⇄ v2
 *   J0018 ⇄ v3
 *   J0019 ⇄ v4
 *   J0020 ⇄ v5
 *   J0021 ⇄ v6
 *
 * 使用方法:
 *   # DRY_RUN
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     node scripts/seed-dealer-bcart-parent-map.mjs
 *
 *   # 本番（DRY_RUN 結果確認後）
 *   EXPECTED_PROJECT_ID=bomber-admin \
 *     SERVICE_ACCOUNT_FILE=scripts/service-account-prod.json \
 *     DRY_RUN=false OPERATOR="社長 ボンバー" \
 *     node scripts/seed-dealer-bcart-parent-map.mjs
 *
 * env:
 *   EXPECTED_PROJECT_ID   必須
 *   SERVICE_ACCOUNT_FILE  既定: scripts/service-account.json
 *   DRY_RUN               'false' 以外は DRY
 *   OPERATOR              本番実行時必須
 *   FORCE_OVERWRITE       'true' で既存値が異なるときの強制上書き（既定 false）
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const EXPECTED_PROJECT_ID = process.env.EXPECTED_PROJECT_ID
if (!EXPECTED_PROJECT_ID) {
  console.error('❌ EXPECTED_PROJECT_ID は必須です（誤実行防止）。')
  process.exit(1)
}
const SA_FILE = process.env.SERVICE_ACCOUNT_FILE || 'scripts/service-account.json'
const SA_PATH = isAbsolute(SA_FILE) ? SA_FILE : resolve(process.cwd(), SA_FILE)
if (!existsSync(SA_PATH)) {
  console.error(`❌ service account JSON が見つかりません: ${SA_PATH}`)
  process.exit(1)
}
const serviceAccount = JSON.parse(readFileSync(SA_PATH, 'utf8'))
if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
  console.error('❌ project_id 不一致のため停止します（誤実行防止）。')
  console.error(`   EXPECTED_PROJECT_ID : ${EXPECTED_PROJECT_ID}`)
  console.error(`   service account     : ${serviceAccount.project_id}`)
  process.exit(1)
}

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const FORCE_OVERWRITE = process.env.FORCE_OVERWRITE === 'true'
const LOG_COLLECTION = 'dealerMappingSeedLogs'
const SCRIPT_VERSION = '2026-04-24.v1'

if (!DRY_RUN && OPERATOR === 'unknown') {
  console.error('❌ 本番実行時は OPERATOR が必須です。')
  process.exit(1)
}

initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.project_id })
const db = getFirestore()

// 既知マッピング（社長確認済み）
const KNOWN_MAPPINGS = [
  { dealerCode: 'J0016', bcartParentId: 'v1' },
  { dealerCode: 'J0017', bcartParentId: 'v2' },
  { dealerCode: 'J0018', bcartParentId: 'v3' },
  { dealerCode: 'J0019', bcartParentId: 'v4' },
  { dealerCode: 'J0020', bcartParentId: 'v5' },
  { dealerCode: 'J0021', bcartParentId: 'v6' },
]

console.log('========================================')
console.log('  seed-dealer-bcart-parent-map.mjs')
console.log(`  project_id     : ${serviceAccount.project_id}`)
console.log(`  client_email   : ${serviceAccount.client_email}`)
console.log(`  SA file        : ${SA_PATH}`)
console.log(`  mode           : ${DRY_RUN ? 'DRY_RUN（書き込まず集計のみ）' : '本番'}`)
console.log(`  operator       : ${OPERATOR}`)
console.log(`  FORCE_OVERWRITE: ${FORCE_OVERWRITE}`)
console.log(`  script version : ${SCRIPT_VERSION}`)
console.log('========================================\n')
console.log(`既知マッピング (${KNOWN_MAPPINGS.length}件):`)
for (const m of KNOWN_MAPPINGS) {
  console.log(`  ${m.dealerCode} ⇄ ${m.bcartParentId}`)
}
console.log('')

async function writeAuditLog({ mode, plan, results }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'dealer-bcart-parent-seed',
      mode,
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      expectedProjectId: EXPECTED_PROJECT_ID,
      forceOverwrite: FORCE_OVERWRITE,
      planCount: plan.length,
      addedCount: results.added.length,
      alreadyMatchedCount: results.alreadyMatched.length,
      conflictCount: results.conflict.length,
      missingDealerCount: results.missingDealer.length,
      added: results.added.map((r) => ({ dealerCode: r.dealerCode, bcartParentId: r.bcartParentId, docId: r.docId })),
      conflicts: results.conflict.map((r) => ({ dealerCode: r.dealerCode, current: r.currentBcartParentId, planned: r.bcartParentId, docId: r.docId })),
      missing: results.missingDealer.map((r) => r.dealerCode),
      scriptVersion: SCRIPT_VERSION,
    })
    console.log(`\n📝 監査ログ保存: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️ 監査ログ書き込み失敗（処理自体は完了）:', e.message)
    return null
  }
}

async function main() {
  // allowedEmails の dealer 全件取得
  console.log('1. allowedEmails (role=dealer) 取得中...')
  const snap = await db.collection('allowedEmails').where('role', '==', 'dealer').get()
  const dealerByCode = new Map()
  for (const d of snap.docs) {
    const data = d.data()
    if (!data.dealerCode) continue
    dealerByCode.set(String(data.dealerCode).trim(), { ref: d.ref, docId: d.id, data })
  }
  console.log(`   登録済み dealer: ${dealerByCode.size} 件\n`)

  // 各マッピングを判定
  console.log('2. マッピング判定中...')
  const results = {
    added: [],          // 新規付与
    alreadyMatched: [], // 既に同値で設定済み
    conflict: [],       // 既に異なる値が設定済み
    missingDealer: [],  // dealerCode に対応する allowedEmails doc がない
  }

  for (const m of KNOWN_MAPPINGS) {
    const target = dealerByCode.get(m.dealerCode)
    if (!target) {
      results.missingDealer.push({ ...m, reason: 'dealerCode not found in allowedEmails' })
      continue
    }
    const current = String(target.data.bcartParentId || '').trim()
    if (current === m.bcartParentId) {
      results.alreadyMatched.push({ ...m, docId: target.docId })
    } else if (current && current !== m.bcartParentId) {
      results.conflict.push({ ...m, currentBcartParentId: current, docId: target.docId, ref: target.ref })
    } else {
      // current 空 → 新規付与
      results.added.push({ ...m, docId: target.docId, ref: target.ref })
    }
  }

  console.log(`   付与予定         : ${results.added.length}`)
  console.log(`   既に同値で設定済み: ${results.alreadyMatched.length}`)
  console.log(`   コンフリクト     : ${results.conflict.length} (FORCE_OVERWRITE=${FORCE_OVERWRITE})`)
  console.log(`   dealer 不在     : ${results.missingDealer.length}`)
  console.log('')

  // 詳細表示
  if (results.added.length) {
    console.log('   --- 付与予定 ---')
    for (const r of results.added) {
      console.log(`     [${DRY_RUN ? 'DRY' : '更新'}] docId=${r.docId} | ${r.dealerCode} ← bcartParentId='${r.bcartParentId}'`)
    }
  }
  if (results.alreadyMatched.length) {
    console.log('   --- 既に同値（スキップ）---')
    for (const r of results.alreadyMatched) {
      console.log(`     docId=${r.docId} | ${r.dealerCode} ⇄ '${r.bcartParentId}' (既設)`)
    }
  }
  if (results.conflict.length) {
    console.log('   --- コンフリクト（手動判断）---')
    for (const r of results.conflict) {
      const action = FORCE_OVERWRITE ? '上書き予定' : 'スキップ'
      console.log(`     [${action}] docId=${r.docId} | ${r.dealerCode}: 現在='${r.currentBcartParentId}' / 予定='${r.bcartParentId}'`)
    }
  }
  if (results.missingDealer.length) {
    console.log('   --- dealer 不在（要事前登録）---')
    for (const r of results.missingDealer) {
      console.log(`     ${r.dealerCode}: allowedEmails に該当 dealer がない`)
    }
  }
  console.log('')

  // 書き込み対象を決定（FORCE_OVERWRITE=true ならコンフリクトも含める）
  const toWrite = [
    ...results.added,
    ...(FORCE_OVERWRITE ? results.conflict : []),
  ]

  if (toWrite.length === 0) {
    console.log('✅ 書き込み対象なし。終了します。')
    await writeAuditLog({ mode: DRY_RUN ? 'dry-run' : 'production', plan: KNOWN_MAPPINGS, results })
    process.exit(0)
  }

  if (DRY_RUN) {
    console.log(`🧪 DRY_RUN: ${toWrite.length} 件の書き込みをスキップします。`)
    await writeAuditLog({ mode: 'dry-run', plan: KNOWN_MAPPINGS, results })
    process.exit(0)
  }

  // 本番更新（少件数なので個別 update）
  console.log(`\n⏳ 本番更新を開始（${toWrite.length} 件）...`)
  const nowTs = FieldValue.serverTimestamp()
  let updated = 0
  for (const r of toWrite) {
    try {
      await r.ref.update({
        bcartParentId: r.bcartParentId,
        bcartParentIdSeededAt: nowTs,
        bcartParentIdSeededBy: OPERATOR,
      })
      updated++
      console.log(`  ✓ ${r.dealerCode} ← '${r.bcartParentId}'`)
    } catch (e) {
      console.error(`  ❌ ${r.dealerCode}: ${e.message}`)
    }
  }

  console.log(`\n========================================`)
  console.log(`  seed 完了`)
  console.log(`========================================`)
  console.log(`  更新件数: ${updated}`)

  await writeAuditLog({ mode: 'production', plan: KNOWN_MAPPINGS, results })
  process.exit(0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
