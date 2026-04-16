import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAuth, sendPasswordResetEmail } from 'firebase/auth'
import { useAuth } from '../contexts/AuthContext.jsx'

export default function WarehouseLogin() {
  const { loginWithEmail, authError } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!email || !password) { setError('IDとパスワードを入力してください'); return }
    setError('')
    setLoading(true)
    try {
      await loginWithEmail(email, password)
      navigate('/warehouse')
    } catch (err) {
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setError('IDまたはパスワードが正しくありません')
      } else if (err.code === 'auth/too-many-requests') {
        setError('ログイン試行回数が多すぎます。しばらくお待ちください')
      } else {
        setError(err.message || 'ログインに失敗しました')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleResetPassword = async () => {
    if (!email) { setError('メールアドレスを入力してください'); return }
    setError('')
    setResetLoading(true)
    try {
      const auth = getAuth()
      await sendPasswordResetEmail(auth, email)
      setResetSent(true)
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setError('このメールアドレスは登録されていません')
      } else {
        setError('送信に失敗しました。しばらく経ってからお試しください')
      }
    } finally {
      setResetLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mb-1 text-2xl font-bold text-gray-900">倉庫管理</div>
          <div className="text-sm text-gray-500">ログイン</div>
        </div>

        <form onSubmit={handleSubmit}>
          <label className="mb-1 block text-xs text-gray-500">ログインID（メールアドレス）</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="warehouse@example.com" autoComplete="email"
            className="mb-4 w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none" />

          <label className="mb-1 block text-xs text-gray-500">パスワード</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="パスワード" autoComplete="current-password"
            className="mb-6 w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none" />

          {(error || authError) && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">
              {error || authError}
            </div>
          )}

          {resetSent && (
            <div className="mb-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">
              パスワード再設定メールを送信しました。メールをご確認ください。
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button onClick={handleResetPassword} disabled={resetLoading}
            className="text-xs text-gray-400 hover:text-indigo-600 disabled:opacity-40">
            {resetLoading ? '送信中...' : 'パスワードを忘れた場合'}
          </button>
        </div>
      </div>
    </div>
  )
}
