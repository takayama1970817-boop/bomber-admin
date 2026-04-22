import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
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
  updateDoc,
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

// 初回/毎回ログイン時に allowedEmails の自己ログイン記録フィールドを更新する。
// rules 側で「loggedIn / lastLoginAt / firstLoginAt の3フィールドだけ」に
// 書き込みを限定しているため、role 昇格などの改ざんは発生しない。
// 失敗しても認証自体は成功済みなので画面進行を止めない（ログだけ残す）。
async function markAllowedEmailLoggedIn(email) {
  if (!email) return
  try {
    const snap = await getDocs(
      query(
        collection(db, 'allowedEmails'),
        where('email', '==', email.toLowerCase()),
      ),
    )
    if (snap.empty) return
    const docSnap = snap.docs[0]
    const data = docSnap.data()
    const patch = {
      loggedIn: true,
      lastLoginAt: serverTimestamp(),
    }
    // firstLoginAt は未設定時のみセット（初回ログインの記録）
    if (!data.firstLoginAt) {
      patch.firstLoginAt = serverTimestamp()
    }
    await updateDoc(doc(db, 'allowedEmails', docSnap.id), patch)
  } catch (e) {
    // rules で弾かれたケース（セッション不整合など）もここに来る。
    // 認証フロー本体は既に成功しているのでエラーは握りつぶし、ログだけ残す。
    console.warn('[AuthContext] allowedEmails ログイン記録更新に失敗:', e.message)
  }
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
              'このメールアドレスはまだ招待されていません。\n'
              + '本社管理者にサロン招待を依頼してください。\n'
              + '（招待済みの場合はメールアドレスのスペルをご確認ください）',
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
            // 通常ログインでも lastLoginAt を更新しておく（休眠検知に使える）
            await markAllowedEmailLoggedIn(fbUser.email)
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

            // subRole: allowedEmails から引き継ぎ
            // 2026-04-17 strict モード移行後は dealer/salon の subRole 欠損は fail-closed。
            // Firestore rules（hasRequiredSubRoleForInvite）でも拒否するため、
            // ここで事前に明確なエラーメッセージを出してサインアウトさせる。
            const initialSubRole = allowSnap.empty
              ? ''
              : (allowSnap.docs[0].data().subRole || '')
            const isSubRoleRequired = initialRole === 'dealer' || initialRole === 'salon'
            if (isSubRoleRequired && !initialSubRole) {
              console.error('[AuthContext] subRole 未設定のため初回作成を拒否:', {
                email: fbUser.email,
                role: initialRole,
              })
              await fbSignOut(auth)
              setAuthError(
                '招待時の権限設定が未完了です。\n'
                + '本社管理者に「管理者」または「スタッフ」の権限設定を依頼してください。',
              )
              setUser(null)
              setProfile(null)
              return
            }
            // salon/dealer 以外の role でも subRole 値が 'admin' / 'staff' 以外で
            // 書き込まれていたら拒否（permissions.js strict モード整合）。
            if (initialSubRole && initialSubRole !== 'admin' && initialSubRole !== 'staff') {
              console.error('[AuthContext] 不正な subRole 値のため初回作成を拒否:', {
                email: fbUser.email,
                subRole: initialSubRole,
              })
              await fbSignOut(auth)
              setAuthError(
                '招待時の権限設定に不正な値が含まれています。\n'
                + '本社管理者に権限の再設定を依頼してください。',
              )
              setUser(null)
              setProfile(null)
              return
            }

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
            // 初回ログイン成立 → allowedEmails の loggedIn/firstLoginAt/lastLoginAt を記録
            await markAllowedEmailLoggedIn(fbUser.email)
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
    try {
      if (isMobile) {
        return await signInWithRedirect(auth, googleProvider)
      }
      return await signInWithPopup(auth, googleProvider)
    } catch (e) {
      // 同じメールで別プロバイダ（パスワード認証）が既に存在するケース。
      // ユーザーに「どちらでログインすればいいか」を明示する。
      if (e.code === 'auth/account-exists-with-different-credential') {
        const err = new Error(
          'このメールアドレスは既にパスワード認証で登録されています。\n'
          + 'メールアドレスとパスワードでログインしてください。',
        )
        err.code = 'auth/account-exists-with-different-credential'
        throw err
      }
      // ポップアップをユーザーが閉じた等はそのまま上位へ
      throw e
    }
  }

  // 初回ログイン時の自動アカウント作成と、既存アカウントのサインインを
  // Firebase v9+ の「invalid-credential に統一された挙動」を前提に
  // fetchSignInMethodsForEmail で分類する実装に変更。
  //
  // 返り値の code（画面側で分岐する用）:
  //   'auth/invited-not-found'      … allowedEmails 未登録（loginWithEmail では出さない。
  //                                    後段の onAuthStateChanged 側で弾く）
  //   'auth/google-only-account'    … Google でのみ登録されている
  //   'auth/wrong-password'         … パスワードが違う
  //   'auth/weak-password'          … 新規作成時のパスワードが弱すぎる
  //   'auth/invalid-email'          … メール形式が不正
  //   'auth/operation-not-allowed'  … プロバイダ未有効（管理者設定ミス）
  const loginWithEmail = async (email, password) => {
    setAuthError(null)
    // まず既存アカウントでのサインインを試みる。
    try {
      return await signInWithEmailAndPassword(auth, email, password)
    } catch (e) {
      // invalid-credential は「未登録」「パスワード違い」「未確認」を統合した
      // 曖昧なエラー。fetchSignInMethodsForEmail で実状を判別する。
      if (e.code === 'auth/invalid-credential'
          || e.code === 'auth/user-not-found'
          || e.code === 'auth/wrong-password') {
        let methods = []
        try {
          methods = await fetchSignInMethodsForEmail(auth, email)
        } catch (fetchErr) {
          // fetch 自体が失敗した場合は原則エラーを素通し（ログのみ）
          console.warn('fetchSignInMethodsForEmail 失敗:', fetchErr.message)
        }

        if (methods.length === 0) {
          // アカウント未登録 → 初回ログイン扱いで新規作成
          try {
            return await createUserWithEmailAndPassword(auth, email, password)
          } catch (createErr) {
            // 作成失敗時はコード別に返す
            if (createErr.code === 'auth/weak-password') {
              const err = new Error(
                'パスワードが弱すぎます。\n'
                + '6文字以上で、できれば英数字を混ぜてください。',
              )
              err.code = 'auth/weak-password'
              throw err
            }
            if (createErr.code === 'auth/email-already-in-use') {
              // 稀なレース（methodsが空だったが直後に作られた等）: パスワード違い扱い
              const err = new Error(
                'パスワードが正しくありません。\n'
                + '「パスワードを忘れた場合」から再設定できます。',
              )
              err.code = 'auth/wrong-password'
              throw err
            }
            throw createErr
          }
        }

        if (methods.includes('password')) {
          // パスワード認証済み → 入力パスワードが違う
          const err = new Error(
            'パスワードが正しくありません。\n'
            + '「パスワードを忘れた場合」から再設定できます。',
          )
          err.code = 'auth/wrong-password'
          throw err
        }

        if (methods.includes('google.com') || methods.some((m) => m.includes('google'))) {
          // Google 専用アカウント → パスワード認証不可
          const err = new Error(
            'このメールアドレスは Google アカウントで登録されています。\n'
            + '「Google アカウントでログイン」ボタンをお使いください。',
          )
          err.code = 'auth/google-only-account'
          throw err
        }

        // 想定外のプロバイダのみ → 汎用エラー
        const err = new Error(
          'このメールアドレスは別の認証方法で登録されています。\n'
          + '本社管理者にお問い合わせください。',
        )
        err.code = 'auth/unsupported-auth-method'
        throw err
      }
      // invalid-credential 以外（invalid-email / operation-not-allowed など）はそのまま
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
