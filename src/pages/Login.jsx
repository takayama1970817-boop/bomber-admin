import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'

export default function Login() {
  const { user, loading, loginWithGoogle, loginWithEmail, authError } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/dashboard'

  const { profile } = useAuth()

  const [method, setMethod] = useState('google') // 'google' or 'password'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && user) {
      // ロール別リダイレクト
      if (profile?.role === 'warehouse') navigate('/warehouse', { replace: true })
      else if (profile?.role === 'dealer') navigate('/dealer', { replace: true })
      else navigate(from, { replace: true })
    }
  }, [loading, user, profile, from, navigate])

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle()
    } catch (e) {
      console.error(e)
      alert('ログインに失敗しました: ' + (e?.code || e?.message || ''))
    }
  }

  const handleEmailLogin = async () => {
    if (!email || !password) {
      alert('メールアドレスとパスワードを入力してください')
      return
    }
    setSubmitting(true)
    try {
      await loginWithEmail(email.trim(), password)
    } catch (e) {
      console.error(e)
      alert('ログインに失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-bold text-gray-900">ロイヤルトラスト</div>
          <div className="text-sm text-gray-500">社内システム</div>
        </div>

        {/* ログイン方式の切替タブ */}
        <div className="mb-5 flex w-full rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            onClick={() => setMethod('google')}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              method === 'google' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            Google
          </button>
          <button
            type="button"
            onClick={() => setMethod('password')}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              method === 'password' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            メール＋パスワード
          </button>
        </div>

        {method === 'google' ? (
          <>
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 active:bg-indigo-800"
            >
              Googleでログイン
            </button>
            <p className="mt-4 text-center text-xs text-gray-400">
              会社のGoogleアカウントでログインしてください
            </p>
          </>
        ) : (
          <>
            <input
              type="email"
              placeholder="メールアドレス"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleEmailLogin()}
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="password"
              placeholder="パスワード"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleEmailLogin()}
              className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleEmailLogin}
              disabled={submitting}
              className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-50"
            >
              {submitting ? 'ログイン中...' : 'ログイン'}
            </button>
          </>
        )}

        {authError && (
          <div className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">
            {authError}
          </div>
        )}
        <div className="mt-4 flex flex-col items-center gap-2 border-t border-gray-100 pt-4">
          <a href="/dealer-login" className="text-xs text-gray-400 hover:text-indigo-600">
            代理店の方はこちら
          </a>
          <a href="/warehouse-login" className="text-xs text-gray-400 hover:text-indigo-600">
            倉庫スタッフはこちら
          </a>
        </div>
      </div>
    </div>
  )
}
