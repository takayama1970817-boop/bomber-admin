import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore'
import { createInterface } from 'readline'
import { getFirebaseConfig, getWarehouseCredentials } from './_env.mjs'

const firebaseConfig = getFirebaseConfig()
const { email: WAREHOUSE_EMAIL, password: WAREHOUSE_PASSWORD } = getWarehouseCredentials()

const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)

const OLD_NAME = 'OHC（福井）'
const NEW_NAME = 'OHC'

// Use warehouse account to authenticate (has write access to products)
async function migrate() {
  console.log('Signing in with warehouse account...')
  await signInWithEmailAndPassword(auth, WAREHOUSE_EMAIL, WAREHOUSE_PASSWORD)
  console.log('Signed in.')

  const snap = await getDocs(collection(db, 'products'))
  let count = 0
  for (const d of snap.docs) {
    const data = d.data()
    if (data.warehouse === OLD_NAME) {
      await updateDoc(doc(db, 'products', d.id), { warehouse: NEW_NAME })
      console.log(`Updated: ${data.name} (${d.id})`)
      count++
    }
  }
  console.log(`Products updated: ${count}`)

  const histSnap = await getDocs(collection(db, 'stockHistory'))
  let hCount = 0
  for (const d of histSnap.docs) {
    const data = d.data()
    let updated = {}
    if (data.warehouse === OLD_NAME) updated.warehouse = NEW_NAME
    if (data.fromWarehouse === OLD_NAME) updated.fromWarehouse = NEW_NAME
    if (data.toWarehouse === OLD_NAME) updated.toWarehouse = NEW_NAME
    if (Object.keys(updated).length > 0) {
      await updateDoc(doc(db, 'stockHistory', d.id), updated)
      hCount++
    }
  }
  console.log(`StockHistory updated: ${hCount}`)
  process.exit(0)
}

migrate().catch(e => { console.error(e); process.exit(1) })
