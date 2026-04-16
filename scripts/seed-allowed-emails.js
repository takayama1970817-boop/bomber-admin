/**
 * 初期設定：allowedEmails に管理者メールアドレスを登録
 *
 * 使い方: node scripts/seed-allowed-emails.js
 *
 * ※ このスクリプトは1回だけ実行してください
 */

import { initializeApp } from 'firebase/app'
import { collection, doc, getDocs, getFirestore, query, serverTimestamp, setDoc, where } from 'firebase/firestore'
import { getFirebaseConfig } from './_env.mjs'

const firebaseConfig = getFirebaseConfig()

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// 最初に登録する管理者メールアドレス
const INITIAL_ADMINS = [
  { email: 'takayama1970817@gmail.com', name: '社長', role: 'admin' },
]

async function seed() {
  for (const admin of INITIAL_ADMINS) {
    const q = query(
      collection(db, 'allowedEmails'),
      where('email', '==', admin.email),
    )
    const snap = await getDocs(q)
    if (!snap.empty) {
      console.log(`スキップ（登録済み）: ${admin.email}`)
      continue
    }
    const ref = doc(collection(db, 'allowedEmails'))
    await setDoc(ref, {
      email: admin.email,
      name: admin.name,
      role: admin.role,
      invitedAt: serverTimestamp(),
      loggedIn: true,
    })
    console.log(`登録完了: ${admin.email}`)
  }
  console.log('完了')
  process.exit(0)
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
