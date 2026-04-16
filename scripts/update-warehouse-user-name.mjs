import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore'
import { getFirebaseConfig, getWarehouseCredentials } from './_env.mjs'

const firebaseConfig = getFirebaseConfig()
const { email: WAREHOUSE_EMAIL, password: WAREHOUSE_PASSWORD } = getWarehouseCredentials()

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

async function main() {
  // admin アカウントでログイン（users コレクションの更新権限が必要）
  console.log('Signing in...')
  await signInWithEmailAndPassword(auth, WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD)
  console.log('Signed in.')

  // users コレクションから k-hashimoto のドキュメントを探す
  const snap = await getDocs(collection(db, 'users'))
  let found = false
  for (const d of snap.docs) {
    const data = d.data()
    if (data.email === 'k-hashimoto@ohc-company.jp') {
      console.log(`Found user doc: ${d.id}, current name: "${data.name}", role: ${data.role}`)
      await updateDoc(doc(db, 'users', d.id), { name: '橋本さん' })
      console.log('Updated name to: 橋本さん')
      found = true
      break
    }
  }
  if (!found) {
    console.log('User document not found for k-hashimoto@ohc-company.jp')
  }
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
