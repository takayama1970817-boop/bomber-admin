import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
} from 'firebase/auth'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { auth, db, googleProvider } from '../lib/firebase.js'
/**
 * 権限判定の単一責任は lib/permissions.js。
 * AuthContext は「認証状態の管理 + 権限判定の引き渡し（ラッパー）」のみ。
 *
 * ⚠️ 権限判定ロジックをこのファイルに書かないこと。
 * 追加・変更は全て lib/permissions.js 側で行い、ここでは import して value に露出するだけ。
 *
 * 新しい権限関数を追加したい場合の手順:
 *   1. lib/permissions.js に関数定義（canXxx）
 *   2. AuthContext の value に perms.canXxx(profile) を露出するか、
 *      画面側で直接 import { canXxx } from '../lib/permissions.js' するか判断
 *   3. 基本は "画面は permissions.js を直接 import" を推奨（この Context を経由しない）
 */
import * as perms from '../lib/permissions.js'

const AuthContext = createContext(null)

// allowedEmails コレクションにメールアドレスが登録されているかチェック
// コレクションが空（初回セットアップ前）なら全員許可（初期ロック防止）
async function isAllowedEmail(email) {
  if (!email) return false
  const allSnap = await getDocs(collection(db, 'allowedEmails'))
  if (allSnap.empty) return true // まだ誰も登録されていない → 全員OK
  return allSnap.docs.some(
    (d) => d.data().email?.toLowerCase() === email.toLowerCase(),
  )
}

// 機能権限のデフォルト（後方互換用）
const DEFAULT_PERMISSIONS = {
  orders: false,
  inventory: true,
  warehouse: true,
  kickback: false,
  users: false,
  bcartImport: false,
  receiptPreview: false,
  calendar: true,
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)   // Firebase User
  const [profile, setProfile] = useState(null) // Firestore users/{uid}
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(null)
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS)
  const [roleAccess, setRoleAccess] = useState(null)
  const [impersonation, setImpersonation] = useState(null) // { originalAdminEmail, originalAdminUid }

  // リダイレクトログインの結果を処理（モバイルGoogleログイン後）
  useEffect(() => {
    getRedirectResult(auth).catch((e) => {
      if (e?.code && e.code !== 'auth/no-auth-event') {
        console.error('リダイレクト結果エラー:', e)
        setAuthError('ログインに失敗しました: ' + (e.code || e.message))
      }
    })
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      try {
        if (fbUser) {
          // 成り代わり検出（カスタムトークンのclaims）
          try {
            const tokenResult = await fbUser.getIdTokenResult()
            if (tokenResult.claims.impersonating) {
              setImpersonation({
                originalAdminEmail: tokenResult.claims.originalAdminEmail || '',
                originalAdminUid: tokenResult.claims.originalAdminUid || '',
              })
            } else {
              setImpersonation(null)
            }
          } catch (e) { console.error('token claims取得エラー:', e) }

          // 許可メールアドレスチェック
          const allowed = await isAllowedEmail(fbUser.email)
          if (!allowed) {
            await fbSignOut(auth)
            setAuthError(
              'このアカウントはアクセスが許可されていません。管理者にお問い合わせください。',
            )
            setUser(null)
            setProfile(null)
            return
          }

          setUser(fbUser)

          // 権限設定を読み込み
          try {
            const permSnap = await getDoc(doc(db, 'settings', 'permissions'))
            if (permSnap.exists()) {
              const data = permSnap.data()
              if (data.roleAccess) setRoleAccess(data.roleAccess)
              if (data.staffAccess) setPermissions({ ...DEFAULT_PERMISSIONS, ...data.staffAccess })
            }
          } catch (e) { console.error('権限設定読み込みエラー:', e) }

          const ref = doc(db, 'users', fbUser.uid)
          const snap = await getDoc(ref)
          if (snap.exists()) {
            setProfile({ uid: fbUser.uid, ...snap.data() })
          } else {
            // allowedEmails から role と companyName を取得
            const allowSnap = await getDocs(
              query(
                collection(db, 'allowedEmails'),
                where('email', '==', fbUser.email.toLowerCase()),
              ),
            )
            let initialRole = 'staff'
            let companyName = ''
            let dealerCode = ''
            let warehouseName = ''
            let salonName = ''
            if (!allowSnap.empty) {
              const allowData = allowSnap.docs[0].data()
              initialRole = allowData.role || 'staff'
              companyName = allowData.companyName || ''
              dealerCode = allowData.dealerCode || ''
              warehouseName = allowData.warehouseName || ''
              salonName = allowData.salonName || ''
            }

            // subRole: allowedEmails から引き継ぎ（未設定時は既存動作互換で admin 扱い）
            const initialSubRole = allowSnap.empty
              ? ''
              : (allowSnap.docs[0].data().subRole || '')

            const data = {
              uid: fbUser.uid,
              name: fbUser.displayName ?? fbUser.email?.split('@')[0] ?? '',
              email: fbUser.email ?? '',
              role: initialRole,
              ...(initialSubRole ? { subRole: initialSubRole } : {}),
              ...(companyName ? { companyName } : {}),
              ...(dealerCode ? { dealerCode } : {}),
              ...(warehouseName ? { warehouseName } : {}),
              ...(salonName ? { salonName } : {}),
              createdAt: serverTimestamp(),
            }
            await setDoc(ref, data)
            setProfile({ ...data })
          }
        } else {
          setUser(null)
          setProfile(null)
        }
      } catch (e) {
        console.error('AuthContext error:', e)
        setAuthError(e.message || 'ログイン処理でエラーが発生しました')
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [])

  const loginWithGoogle = async () => {
    setAuthError(null)
    // モバイルではリダイレクト方式（ポップアップがブロックされるため）
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    if (isMobile) {
      return signInWithRedirect(auth, googleProvider)
    }
    return signInWithPopup(auth, googleProvider)
  }
  const loginWithEmail = async (email, password) => {
    setAuthError(null)
    try {
      return await signInWithEmailAndPassword(auth, email, password)
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // ユーザーが存在しない → 初回ログイン → アカウント自動作成
        return await createUserWithEmailAndPassword(auth, email, password)
      }
      if (e.code === 'auth/invalid-credential') {
        // Firebase v9+ では user-not-found も invalid-credential で返る場合がある
        // まず新規作成を試み、email-already-in-use ならパスワード間違い
        try {
          return await createUserWithEmailAndPassword(auth, email, password)
        } catch (e2) {
          if (e2.code === 'auth/email-already-in-use') {
            // アカウントは存在する＝パスワードが間違い
            const err = new Error('メールアドレスまたはパスワードが正しくありません')
            err.code = 'auth/wrong-password'
            throw err
          }
          throw e2
        }
      }
      throw e
    }
  }
  const logout = () => fbSignOut(auth)

  // 機能へのアクセス権チェック: roleAccessがあればロール別、なければ旧形式
  const hasAccess = (feature) => {
    const role = profile?.role
    if (role === 'master') return true
    if (roleAccess && roleAccess[role]) return !!roleAccess[role][feature]
    // 旧形式フォールバック
    if (role === 'admin') return true
    if (role === 'staff') return !!permissions[feature]
    return false
  }

  // permissions.js に単一責任を委譲（AuthContext は引き渡し役）
  // 判定ロジックは lib/permissions.js 側で定義、画面側は直接 canXxx(profile) を呼ぶ
  const value = {
    user,
    profile,
    loading,
    authError,
    isMaster: perms.isMaster(profile),
    isAdmin: perms.isAdmin(profile),
    isDealer: perms.isDealer(profile),
    isDealerAdmin: perms.isDealerAdmin(profile),
    isDealerStaff: perms.isDealerStaff(profile),
    isWarehouse: perms.isWarehouse(profile),
    isSalon: perms.isSalon(profile),
    isSalonAdmin: perms.isSalonAdmin(profile),
    isSalonStaff: perms.isSalonStaff(profile),
    permissions,
    hasAccess,
    loginWithGoogle,
    loginWithEmail,
    logout,
    impersonation,
    isImpersonating: !!impersonation,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
