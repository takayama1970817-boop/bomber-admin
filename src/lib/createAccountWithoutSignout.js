/**
 * 現在ログイン中のユーザーをサインアウトせずに新規アカウントを作成する
 * セカンダリ Firebase App インスタンスを使用
 */
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser, signOut } from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export async function createAccountWithoutSignout(email, password) {
  // セカンダリアプリを作成（ランダム名で衝突回避）
  const tempApp = initializeApp(firebaseConfig, `temp-${Date.now()}`)
  const tempAuth = getAuth(tempApp)

  try {
    const cred = await createUserWithEmailAndPassword(tempAuth, email, password)
    const uid = cred.user.uid

    // セカンダリアプリからサインアウト
    await signOut(tempAuth)

    return uid
  } finally {
    // セカンダリアプリを削除
    await deleteApp(tempApp)
  }
}

/**
 * 既存アカウントにサインインしてUIDを取得（管理者はサインアウトされない）
 * パスワードが一致すればUIDを返す
 */
export async function signInExisting(email, password) {
  const tempApp = initializeApp(firebaseConfig, `temp-signin-${Date.now()}`)
  const tempAuth = getAuth(tempApp)

  try {
    const cred = await signInWithEmailAndPassword(tempAuth, email, password)
    const uid = cred.user.uid
    await signOut(tempAuth)
    return uid
  } finally {
    await deleteApp(tempApp)
  }
}

/**
 * 既存のAuthアカウントを削除してから新規作成（管理者はサインアウトされない）
 * 削除→再作成のケースで使用
 */
export async function recreateAccount(email, oldPassword, newPassword) {
  const tempApp = initializeApp(firebaseConfig, `temp-recreate-${Date.now()}`)
  const tempAuth = getAuth(tempApp)

  try {
    // 既存アカウントにサインインして削除
    const cred = await signInWithEmailAndPassword(tempAuth, email, oldPassword)
    await deleteUser(cred.user)
  } catch (e) {
    // サインインできなくても続行（パスワード不一致の場合）
    await deleteApp(tempApp)
    throw new Error('既存アカウントのパスワードが一致しません。Firebaseコンソールから手動で削除してください。')
  }

  await deleteApp(tempApp)

  // 新規作成
  return await createAccountWithoutSignout(email, newPassword)
}
