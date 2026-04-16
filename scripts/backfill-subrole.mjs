/**
 * subRole 一括付与スクリプト（Admin SDK 版）
 *
 * 目的: 既存の dealer / salon ユーザー（allowedEmails + users 両方）に
 *       subRole が未設定 or 空のものを全員 'admin' に統一する。
 *       staff は手動で招待したもののみに限定する前提。
 *
 * 前提: scripts/service-account.json に Firebase Admin SDK の秘密鍵
 *
 * 使用方法:
 *   node scripts/backfill-subrole.mjs              (DRY RUN: 確認のみ)
 *   DRY_RUN=false node scripts/backfill-subrole.mjs (本番)
 *
 * ログ出力:
 *   - 対象ID一覧（更新前）
 *   - 件数サマリ（対象 / スキップ / 失敗）
 *   - 失敗したIDリスト
 */
import { readFileSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const serviceAccount = JSON.parse(
  readFileSync(new URL('./service-account.json', import.meta.url), 'utf8'),
)

initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const TARGET_ROLES = ['dealer', 'salon']
const DEFAULT_SUB_ROLE = 'admin'

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
    if (sub === 'admin' || sub === 'staff') {
      alreadySet.push({ id: d.id, role, subRole: sub })
      continue
    }

    // 未設定 or 不正値 → admin を付与
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
      console.log(`  [${DRY_RUN ? 'DRY' : '付与'}] ${t.id}  role=${t.role}  current=${t.currentSubRole ?? '未設定'}  ${hint}`)
    }
  }

  if (DRY_RUN) {
    return { updated: 0, failed: [] }
  }

  // 本番更新
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
  return { updated, failed }
}

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

async function main() {
  if (DRY_RUN) {
    console.log('🧪 DRY RUN モード（実際には更新しません）')
    console.log('   本番: DRY_RUN=false node scripts/backfill-subrole.mjs\n')
  } else {
    console.log('⚠️  本番モード\n')
  }

  const collections = ['allowedEmails', 'users']
  let totalUpdated = 0
  const allFailed = []

  for (const c of collections) {
    const { updated, failed } = await processCollection(c)
    totalUpdated += updated
    allFailed.push(...failed.map((f) => ({ collection: c, ...f })))
  }

  if (!DRY_RUN) {
    console.log('\n\n🔍 検証: 未設定ユーザーの残存チェック')
    for (const c of collections) {
      const { missing, missingIds } = await verify(c)
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

  process.exit(0)
}

main().catch((e) => {
  console.error('❌ エラー:', e)
  process.exit(1)
})
