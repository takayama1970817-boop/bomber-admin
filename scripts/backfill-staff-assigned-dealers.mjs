/**
 * staff の assignedDealerCodes 一括付与スクリプト（Admin SDK 版）
 *
 * 目的:
 *   PR3 の Phase 2 で dealerMonthlySnapshots の rules を
 *   `staff は assignedDealerCodes に列挙された dealer のみ閲覧可` に
 *   切り替える事前準備。切替前に全 staff へ全 dealer の grandfathering 付与を行い、
 *   切替時に「権限が突然消える」事故を防ぐ。
 *
 * 3要件（既存の backfill-subrole.mjs と同じ受け入れ基準）:
 *   1. ドライラン — 既定で DRY。実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全 — 既に assignedDealerCodes が設定済みの staff は必ずスキップ（冪等）
 *   3. ログ       — 実行のたびに staffAssignmentBackfillLogs コレクションに監査ログ
 *
 * 対象:
 *   users コレクションの role === 'staff' のドキュメントのうち、
 *   assignedDealerCodes フィールドが「未設定」のもの。
 *   既に空配列 [] が明示されている staff は意図的に「閲覧不可」設定とみなしてスキップする。
 *
 * 付与する内容:
 *   全ての dealer の dealerCode を一括付与（grandfathering）。
 *   付与後 admin が管理 UI で個別に絞り込む前提。
 *
 * dealer データのソース:
 *   - users コレクション where role='dealer'
 *   - allowedEmails コレクション where role='dealer'
 *   両方の dealerCode を union して使う。
 *   （独立した 'dealers' コレクションは存在しない）
 *
 * 前提:
 *   scripts/service-account.json に Firebase Admin SDK の秘密鍵
 *   （.gitignore 済み。コミットしないこと）
 *
 * 使用方法:
 *   # ドライラン（現状調査のみ。何も書き込まない）
 *   node scripts/backfill-staff-assigned-dealers.mjs
 *
 *   # 本番（監査ログも書き込む）
 *   DRY_RUN=false OPERATOR="社長 ボンバー" node scripts/backfill-staff-assigned-dealers.mjs
 *
 * 出力:
 *   - 標準出力: サマリ + 対象 staff 詳細 + 失敗詳細
 *   - Firestore: staffAssignmentBackfillLogs/{auto-id} に実行記録（本番実行時のみ）
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
const OPERATOR = process.env.OPERATOR || 'unknown'
const LOG_COLLECTION = 'staffAssignmentBackfillLogs'
const TARGET_ROLE = 'staff'

console.log('========================================')
console.log('  staff.assignedDealerCodes バックフィル')
console.log(`  モード: ${DRY_RUN ? 'DRY_RUN（書き込みなし）' : '本番（書き込み実行）'}`)
console.log(`  操作者: ${OPERATOR}`)
console.log('========================================\n')

/** dealers から有効な dealerCode を全列挙 */
async function fetchAllDealerCodes() {
  console.log('1. 全 dealer の dealerCode を取得中...')
  // 旧版は db.collection('dealers') を見ていたが、本リポジトリには
  // 'dealers' という独立コレクションは存在しない。
  // dealer データは users / allowedEmails の role='dealer' で表現される。
  //
  // ソース・オブ・トゥルース:
  //   1. users where role='dealer' … ログイン済みの dealer。Dealers.jsx もここから取得
  //   2. allowedEmails where role='dealer' … 招待済みだが未ログインの dealer
  // → union を取り、いずれかに登録があれば backfill 対象に含める
  const [usersSnap, allowSnap] = await Promise.all([
    db.collection('users').where('role', '==', 'dealer').get(),
    db.collection('allowedEmails').where('role', '==', 'dealer').get(),
  ])

  const codesFromUsers = new Set()
  for (const d of usersSnap.docs) {
    const code = (d.data().dealerCode || '').trim()
    if (code) codesFromUsers.add(code)
  }
  const codesFromAllow = new Set()
  for (const d of allowSnap.docs) {
    const code = (d.data().dealerCode || '').trim()
    if (code) codesFromAllow.add(code)
  }

  // union + ソート（再実行時の差分が見やすいよう安定化）
  const unique = [...new Set([...codesFromUsers, ...codesFromAllow])].sort()

  console.log(
    `   users.role=dealer: ${usersSnap.size}件 (有効code ${codesFromUsers.size})  /  `
    + `allowedEmails.role=dealer: ${allowSnap.size}件 (有効code ${codesFromAllow.size})  /  `
    + `union 有効 dealerCode: ${unique.length}件\n`,
  )
  return unique
}

/** users から role=staff を取得し、assignedDealerCodes 状態を分類 */
async function classifyStaff() {
  console.log('2. staff users を分類中...')
  const snap = await db.collection('users').where('role', '==', TARGET_ROLE).get()

  const targets = []         // 未設定 → 付与対象
  const explicitlyEmpty = [] // 空配列 [] が明示されている → 意図的に閲覧不可とみなしスキップ
  const alreadySet = []      // 配列に1件以上 → スキップ
  const malformed = []       // 配列以外の型 → スキップ + 警告

  for (const d of snap.docs) {
    const data = d.data()
    const v = data.assignedDealerCodes
    const meta = {
      id: d.id,
      email: data.email || '',
      name: data.name || '',
      companyName: data.companyName || '',
    }
    if (v === undefined) {
      targets.push(meta)
    } else if (Array.isArray(v) && v.length === 0) {
      explicitlyEmpty.push(meta)
    } else if (Array.isArray(v)) {
      alreadySet.push({ ...meta, count: v.length })
    } else {
      malformed.push({ ...meta, type: typeof v, value: JSON.stringify(v).slice(0, 80) })
    }
  }

  console.log(`   staff 総数: ${snap.size}件`)
  console.log(`   付与対象（未設定）: ${targets.length}件`)
  console.log(`   既に設定済み（>0件）: ${alreadySet.length}件`)
  console.log(`   明示的に空配列（意図的に閲覧不可）: ${explicitlyEmpty.length}件`)
  console.log(`   ⚠️  異常な型（手動調査要）: ${malformed.length}件`)
  console.log('')

  return { targets, explicitlyEmpty, alreadySet, malformed, total: snap.size }
}

/** 詳細を出力 */
function printDetails(targets, explicitlyEmpty, alreadySet, malformed) {
  if (targets.length > 0) {
    console.log('--- 付与対象 staff ---')
    for (const t of targets) {
      const hint = t.companyName || t.name || t.email || '(no info)'
      console.log(`  [${DRY_RUN ? 'DRY' : '付与'}] uid=${t.id}  ${hint}`)
    }
    console.log('')
  }

  if (alreadySet.length > 0) {
    console.log('--- スキップ（既に設定済み） ---')
    for (const t of alreadySet) {
      const hint = t.companyName || t.name || t.email || '(no info)'
      console.log(`  uid=${t.id}  count=${t.count}  ${hint}`)
    }
    console.log('')
  }

  if (explicitlyEmpty.length > 0) {
    console.log('--- スキップ（明示的に空配列＝意図的に閲覧不可） ---')
    for (const t of explicitlyEmpty) {
      const hint = t.companyName || t.name || t.email || '(no info)'
      console.log(`  uid=${t.id}  ${hint}`)
    }
    console.log('')
  }

  if (malformed.length > 0) {
    console.log('--- ⚠️  異常な型（手動調査要） ---')
    for (const m of malformed) {
      const hint = m.companyName || m.name || m.email || '(no info)'
      console.log(`  uid=${m.id}  type=${m.type}  value=${m.value}  ${hint}`)
    }
    console.log('')
  }
}

/** 本番更新を実行 */
async function applyUpdates(targets, allDealerCodes) {
  console.log(`3. 本番更新中（${targets.length}件）...\n`)
  let updated = 0
  const failed = []
  for (const t of targets) {
    try {
      await db.collection('users').doc(t.id).update({
        assignedDealerCodes: allDealerCodes,
        assignedDealerCodesBackfilledAt: FieldValue.serverTimestamp(),
      })
      updated += 1
    } catch (e) {
      failed.push({ id: t.id, error: e.message })
    }
  }
  console.log(`✅ 付与完了: ${updated}件 / 失敗: ${failed.length}件\n`)
  if (failed.length > 0) {
    console.log('--- 失敗詳細 ---')
    for (const f of failed) console.log(`  uid=${f.id}: ${f.error}`)
    console.log('')
  }
  return { updated, failed }
}

/** 監査ログを書き込む */
async function writeAuditLog(payload) {
  const docRef = await db.collection(LOG_COLLECTION).add({
    ...payload,
    operator: OPERATOR,
    executedAt: FieldValue.serverTimestamp(),
  })
  console.log(`📝 監査ログ: ${LOG_COLLECTION}/${docRef.id}\n`)
}

/** 検証：対象 staff で assignedDealerCodes 未設定が残っていないか */
async function verify() {
  console.log('4. 検証中...')
  const snap = await db.collection('users').where('role', '==', TARGET_ROLE).get()
  let missing = 0
  const missingIds = []
  for (const d of snap.docs) {
    const v = d.data().assignedDealerCodes
    if (v === undefined) {
      missing += 1
      missingIds.push(d.id)
    }
  }
  if (missing === 0) {
    console.log('   ✅ assignedDealerCodes 未設定の staff: 0件\n')
  } else {
    console.log(`   ⚠️  まだ未設定の staff: ${missing}件`)
    for (const id of missingIds) console.log(`      uid=${id}`)
    console.log('')
  }
  return { missing, missingIds }
}

async function main() {
  const allDealerCodes = await fetchAllDealerCodes()
  // dealerCode が 0 件の場合の扱い:
  //   - DRY_RUN: 警告のみで継続（staff 分類まで見せて状況把握を優先）
  //   - 本番:    fail-closed で停止（grandfathering の前提が崩れた状態で書き込まない）
  if (allDealerCodes.length === 0) {
    if (DRY_RUN) {
      console.warn(
        '⚠️  dealerCode が 1 件も取得できませんでした。'
        + ' （users.role=dealer / allowedEmails.role=dealer どちらも 0 件）\n'
        + '   付与する内容が無いため backfill は no-op になります。'
        + ' staff 分類のみ表示します。\n',
      )
    } else {
      console.error(
        '❌ dealerCode が 1 件も取得できませんでした。'
        + ' （users.role=dealer / allowedEmails.role=dealer どちらも 0 件）\n'
        + '   本番実行は中断します。dealer 登録運用を整備してから再実行してください。',
      )
      process.exit(1)
    }
  }

  const { targets, explicitlyEmpty, alreadySet, malformed, total } = await classifyStaff()
  printDetails(targets, explicitlyEmpty, alreadySet, malformed)

  let updateResult = { updated: 0, failed: [] }
  let verifyResult = { missing: targets.length, missingIds: [] }

  // dealerCode が 1 件以上ある場合のみ本番更新を行う（0 件なら付与する中身が無い）
  if (!DRY_RUN && targets.length > 0 && allDealerCodes.length > 0) {
    updateResult = await applyUpdates(targets, allDealerCodes)
    verifyResult = await verify()
  }

  // 監査ログ（本番実行時のみ）
  if (!DRY_RUN) {
    await writeAuditLog({
      mode: 'production',
      totalStaff: total,
      targetCount: targets.length,
      explicitlyEmptyCount: explicitlyEmpty.length,
      alreadySetCount: alreadySet.length,
      malformedCount: malformed.length,
      updatedCount: updateResult.updated,
      failedCount: updateResult.failed.length,
      failedIds: updateResult.failed.map((f) => f.id),
      malformedIds: malformed.map((m) => m.id),
      verifyMissing: verifyResult.missing,
      dealerCodeCount: allDealerCodes.length,
    })
  }

  console.log('========================================')
  console.log('  完了サマリ')
  console.log('========================================')
  console.log(`  staff 総数:               ${total}件`)
  console.log(`  付与対象:                 ${targets.length}件`)
  console.log(`  既設定スキップ:           ${alreadySet.length}件`)
  console.log(`  明示空配列スキップ:       ${explicitlyEmpty.length}件`)
  console.log(`  異常型（要手動）:         ${malformed.length}件`)
  if (!DRY_RUN) {
    console.log(`  実際に更新:               ${updateResult.updated}件`)
    console.log(`  失敗:                     ${updateResult.failed.length}件`)
    console.log(`  検証 残存未設定:          ${verifyResult.missing}件`)
  } else {
    console.log('  ※ DRY_RUN: 実書き込み・監査ログ書き込みは行っていません')
  }
}

main().catch((e) => {
  console.error('\n❌ 予期せぬエラー:', e)
  process.exit(1)
})
