/**
 * dealerDocuments に visibility / allowedDealers / allowedCompanies / isActive
 * のフィールドをバックフィル。
 *
 * 目的:
 *   新ルール（canReadDealerDocument）導入前に、既存ドキュメントを
 *   現状と等価の挙動（全員読める）に揃える。
 *   → デフォルト: visibility='all', isActive=true, allowedDealers=[], allowedCompanies=[]
 *   → RT admin は後から UI で個別に visibility を絞り込める。
 *
 * 要件:
 *   1. ドライラン既定
 *   2. 再実行安全（既にフィールドがある項目は触らない）
 *   3. 集計表示
 *
 * 使用方法:
 *   # ドライラン
 *   node scripts/backfill-dealer-document-visibility.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false node scripts/backfill-dealer-document-visibility.mjs
 *
 * 必要な認証ファイル:
 *   scripts/service-account.json（本番: bomber-admin のサービスアカウント）
 */
import { readFileSync, existsSync } from 'fs'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OPERATOR = process.env.OPERATOR || 'unknown'
const BATCH_SIZE = 400

async function main() {
  console.log('=== dealerDocuments visibility バックフィル ===')
  console.log(`モード  : ${DRY_RUN ? '🟡 DRY RUN（書き込みなし）' : '🔴 本番実行'}`)
  console.log(`OPERATOR: ${OPERATOR}`)
  console.log('')

  const snap = await db.collection('dealerDocuments').get()
  console.log(`dealerDocuments 総件数: ${snap.size}`)
  console.log('')

  const toUpdate = []
  let alreadyFullySet = 0
  let partiallyMissing = 0
  let visibilityAssigned = 0
  let isActiveAssigned = 0
  let allowedDealersAssigned = 0
  let allowedCompaniesAssigned = 0

  snap.forEach((d) => {
    const data = d.data()
    const patch = {}
    let needsUpdate = false

    if (data.visibility === undefined) {
      patch.visibility = 'all'
      visibilityAssigned++
      needsUpdate = true
    }
    if (data.isActive === undefined) {
      patch.isActive = true
      isActiveAssigned++
      needsUpdate = true
    }
    if (data.allowedDealers === undefined) {
      patch.allowedDealers = []
      allowedDealersAssigned++
      needsUpdate = true
    }
    if (data.allowedCompanies === undefined) {
      patch.allowedCompanies = []
      allowedCompaniesAssigned++
      needsUpdate = true
    }

    if (!needsUpdate) {
      alreadyFullySet++
    } else {
      if (Object.keys(patch).length < 4) partiallyMissing++
      toUpdate.push({ id: d.id, title: data.title || '(無題)', patch })
    }
  })

  if (!DRY_RUN && toUpdate.length > 0) {
    console.log(`▶ 書き込み: ${toUpdate.length} 件を ${BATCH_SIZE} 件ずつ処理...`)
    let written = 0
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const chunk = toUpdate.slice(i, i + BATCH_SIZE)
      const batch = db.batch()
      chunk.forEach((item) => {
        batch.update(db.collection('dealerDocuments').doc(item.id), item.patch)
      })
      await batch.commit()
      written += chunk.length
      console.log(`  ${written}/${toUpdate.length} 件 書き込み完了`)
    }
    console.log('')
  }

  console.log('=== 集計 ===')
  console.log(`既に全フィールド設定済み  : ${alreadyFullySet}`)
  console.log(`更新対象                  : ${toUpdate.length}`)
  console.log(`  - 一部のみ欠損         : ${partiallyMissing}`)
  console.log(`  - 全フィールド欠損     : ${toUpdate.length - partiallyMissing}`)
  console.log('')
  console.log(`付与: visibility         : ${visibilityAssigned}`)
  console.log(`付与: isActive           : ${isActiveAssigned}`)
  console.log(`付与: allowedDealers     : ${allowedDealersAssigned}`)
  console.log(`付与: allowedCompanies   : ${allowedCompaniesAssigned}`)
  console.log('')

  if (toUpdate.length > 0 && toUpdate.length <= 30) {
    console.log('=== 更新対象ドキュメント ===')
    toUpdate.forEach((u, i) => {
      console.log(`  ${(i + 1).toString().padStart(2)}. [${u.id}] ${u.title}`)
      console.log(`      → ${JSON.stringify(u.patch)}`)
    })
    console.log('')
  }

  if (DRY_RUN) {
    console.log('🟡 DRY RUN モードでした。実際には書き込んでいません。')
    console.log('   本番実行: DRY_RUN=false node scripts/backfill-dealer-document-visibility.mjs')
  } else {
    console.log(`🟢 本番実行完了: ${toUpdate.length} 件を更新。`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
