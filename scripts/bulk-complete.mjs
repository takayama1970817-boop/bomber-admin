/**
 * 4/10以前の受注をすべて「完了」にする一括更新スクリプト
 * 使い方: node scripts/bulk-complete.mjs
 */
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore'
import { getFirebaseConfig, getScriptCredentials } from './_env.mjs'

const firebaseConfig = getFirebaseConfig()
const { email: SCRIPT_EMAIL, password: SCRIPT_PASSWORD } = getScriptCredentials()

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

// 締切日: 2026-04-10 23:59:59
const CUTOFF = new Date(2026, 3, 10, 23, 59, 59)

async function main() {
  console.log('ログイン中...')
  await signInWithEmailAndPassword(auth, SCRIPT_EMAIL, SCRIPT_PASSWORD)
  console.log('ログイン成功')

  console.log('受注データ取得中...')
  const snap = await getDocs(collection(db, 'orders'))
  console.log(`全 ${snap.size} 件の受注を確認`)

  const targets = []
  snap.docs.forEach((d) => {
    const data = d.data()
    if (data.status === 'completed') return // 既に完了

    const orderDate = data.orderDate?.toDate?.()
      || (data.orderDate ? new Date(data.orderDate) : null)
    if (!orderDate) return
    if (orderDate > CUTOFF) return

    targets.push({ id: d.id, date: orderDate, company: data.companyName || '—' })
  })

  console.log(`4/10以前の未完了受注: ${targets.length} 件`)

  if (targets.length === 0) {
    console.log('更新対象なし。終了。')
    process.exit(0)
  }

  // バッチ更新（500件制限）
  const BATCH_SIZE = 400
  let updated = 0
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE)
    const batch = writeBatch(db)
    chunk.forEach((t) => {
      batch.update(doc(db, 'orders', t.id), {
        status: 'completed',
        statusUpdatedAt: serverTimestamp(),
      })
    })
    await batch.commit()
    updated += chunk.length
    console.log(`  ${updated} / ${targets.length} 件更新完了`)
  }

  console.log(`\n完了: ${updated} 件の受注を「完了」に更新しました`)
  process.exit(0)
}

main().catch((e) => {
  console.error('エラー:', e.message)
  process.exit(1)
})
