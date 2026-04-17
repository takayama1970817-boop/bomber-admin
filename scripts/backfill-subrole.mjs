/**
 * subRole 現状調査 + 一括付与スクリプト（Admin SDK 版）
 *
 * 目的:
 *   既存の dealer / salon ユーザー（allowedEmails + users 両方）に
 *   subRole が未設定 or 空のものを全員 'admin' に統一する。
 *   staff は手動で招待したもののみに限定する前提。
 *
 * 3要件（社長確定の受け入れ基準）:
 *   1. ドライラン — 既定で DRY。実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全 — 既に 'admin'/'staff' が設定されたユーザーは必ずスキップ（冪等）
 *   3. ログ       — 実行のたびに subRoleBackfillLogs コレクションに監査ログを残す
 *
 * 前提:
 *   scripts/service-account.json に Firebase Admin SDK の秘密鍵
 *   （.gitignore 済み。コミットしないこと）
 *
 * 使用方法:
 *   # ドライラン（現状調査のみ。何も書き込まない）
 *   node scripts/backfill-subrole.mjs
 *
 *   # 本番（監査ログも書き込む）
 *   DRY_RUN=false node scripts/backfill-subrole.mjs
 *
 *   # 記録者メモ（監査ログに残せる）
 *   OPERATOR="社長 ボンバー" DRY_RUN=false node scripts/backfill-subrole.mjs
 *
 * 出力:
 *   - 標準出力: サマリ + 対象 ID 詳細 + 失敗詳細
 *   - Firestore: subRoleBackfillLogs/{auto-id} に実行記録（本番実行時のみ）
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
const TARGET_ROLES = ['dealer', 'salon']
const DEFAULT_SUB_ROLE = 'admin'
const LOG_COLLECTION = 'subRoleBackfillLogs'

/** 1コレクション分を調査＋（本番時は）更新する */
async function processCollection(collectionName) {
  console.log(`\n=== ${collectionName} ===`)
  const snap = await db.collection(collectionName).get()

  const targets = []
  const alreadySet = []
  const skipped = []

  for (const d of snap.docs) {
    const data = d.data()
    const role = data.role

    // 対象外 role（master/admin/staff/warehouse）はスキップ
    if (!TARGET_ROLES.includes(role)) {
      skipped.push({ id: d.id, role, reason: `非対象role=${role}` })
      continue
    }

    const sub = data.subRole
    // 再実行安全：既に正しい値がセットされていれば絶対触らない
    if (sub === 'admin' || sub === 'staff') {
      alreadySet.push({ id: d.id, role, subRole: sub })
      continue
    }

    // 未設定 or 不正値 → admin を付与対象
    targets.push({
      id: d.id,
      role,
      currentSubRole: sub ?? null,
      email: data.email || '',
      companyName: data.companyName || '',
      salonName: data.salonName || '',
      dealerCode: data.dealerCode || '',
    })
  }

  console.log(`総数: ${snap.size}件`)
  console.log(`対象（要付与）: ${targets.length}件`)
  console.log(`既に設定済み: ${alreadySet.length}件`)
  console.log(`対象外（role=master/admin/staff/warehouse等）: ${skipped.length}件`)

  if (targets.length > 0) {
    console.log('\n--- 付与対象 ---')
    for (const t of targets) {
      const hint = t.companyName || t.salonName || t.email
      console.log(
        `  [${DRY_RUN ? 'DRY' : '付与'}] ${t.id}  role=${t.role}  current=${t.currentSubRole ?? '未設定'}  ${hint}`,
      )
    }
  }

  if (DRY_RUN) {
    return {
      collection: collectionName,
      total: snap.size,
      targetCount: targets.length,
      alreadySetCount: alreadySet.length,
      skippedCount: skipped.length,
      updated: 0,
      failed: [],
      targetIds: targets.map((t) => t.id),
    }
  }

  // 本番更新（再実行安全：既に admin/staff のものは targets に入らないのでここに来ない）
  let updated = 0
  const failed = []
  for (const t of targets) {
    try {
      await db.collection(collectionName).doc(t.id).update({
        subRole: DEFAULT_SUB_ROLE,
        subRoleBackfilledAt: FieldValue.serverTimestamp(),
      })
      updated += 1
    } catch (e) {
      failed.push({ id: t.id, error: e.message })
    }
  }
  console.log(`\n✅ ${collectionName} 付与完了: ${updated}件  /  失敗: ${failed.length}件`)
  if (failed.length > 0) {
    console.log('--- 失敗 ID ---')
    for (const f of failed) console.log(`  ${f.id}: ${f.error}`)
  }
  return {
    collection: collectionName,
    total: snap.size,
    targetCount: targets.length,
    alreadySetCount: alreadySet.length,
    skippedCount: skipped.length,
    updated,
    failed,
    targetIds: targets.map((t) => t.id),
  }
}

/** 更新後の検証：対象 role で subRole 未設定が残ってないか */
async function verify(collectionName) {
  const snap = await db.collection(collectionName).get()
  let missing = 0
  const missingIds = []
  for (const d of snap.docs) {
    const data = d.data()
    if (!TARGET_ROLES.includes(data.role)) continue
    if (data.subRole !== 'admin' && data.subRole !== 'staff') {
      missing += 1
      missingIds.push(d.id)
    }
  }
  return { missing, missingIds }
}

/** 実行結果を Firestore に永続化（監査ログ） */
async function writeAuditLog({ mode, results, verifications }) {
  try {
    const ref = await db.collection(LOG_COLLECTION).add({
      type: 'subrole-backfill',
      mode, // 'dry-run' | 'production'
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      defaultSubRole: DEFAULT_SUB_ROLE,
      targetRoles: TARGET_ROLES,
      results,
      verifications: verifications || null,
      scriptVersion: '2026-04-17.v2',
    })
    console.log(`\n📝 監査ログを保存しました: ${LOG_COLLECTION}/${ref.id}`)
    return ref.id
  } catch (e) {
    console.error('⚠️  監査ログ書き込み失敗（処理自体は完了しています）:', e.message)
    return null
  }
}

async function main() {
  if (DRY_RUN) {
    console.log('🧪 DRY RUN モード（実際には更新しません）')
    console.log('   本番: DRY_RUN=false node scripts/backfill-subrole.mjs\n')
  } else {
    console.log('⚠️  本番モード')
    console.log(`   OPERATOR=${OPERATOR}\n`)
  }

  const collections = ['allowedEmails', 'users']
  const results = []
  let totalUpdated = 0
  const allFailed = []

  for (const c of collections) {
    const r = await processCollection(c)
    results.push(r)
    totalUpdated += r.updated
    allFailed.push(...r.failed.map((f) => ({ collection: c, ...f })))
  }

  // ---- 本番のみ：検証 + 監査ログ
  let verifications = null
  if (!DRY_RUN) {
    console.log('\n\n🔍 検証: 未設定ユーザーの残存チェック')
    verifications = {}
    for (const c of collections) {
      const { missing, missingIds } = await verify(c)
      verifications[c] = { missing, missingIds }
      if (missing === 0) {
        console.log(`  ✅ ${c}: 未設定 0件`)
      } else {
        console.log(`  ⚠️  ${c}: 未設定 ${missing}件 — IDs: ${missingIds.join(', ')}`)
      }
    }
    console.log(`\n✅ 総更新件数: ${totalUpdated}件`)
    if (allFailed.length > 0) {
      console.log(`❌ 失敗: ${allFailed.length}件`)
      for (const f of allFailed) console.log(`  [${f.collection}] ${f.id}: ${f.error}`)
    }
  }

  // ログは dry / prod 両方で保存する（運用履歴を完全に追えるように）
  await writeAuditLog({
    mode: DRY_RUN ? 'dry-run' : 'production',
    results,
    verifications,
  })

  process.exit(0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
