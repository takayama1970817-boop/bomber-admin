import { useState } from 'react'
import {
  collection, doc, getDocs, query, where, addDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../../lib/firebase.js'

/**
 * 公開メルマガ登録フォーム（認証不要）
 * URL: /newsletter/subscribe
 *
 * 特定電子メール法対応：
 * - 登録日時・登録経路・同意方法を nl_readers に記録
 * - ダブルオプトインではなくシングルオプトイン（登録完了時点で同意）
 */
export default function NewsletterSubscribe() {
  const [form, setForm] = useState({ email: '', name: '', company: '', type: 'salon' })
  const [status, setStatus] = useState('idle') // idle | submitting | done | duplicate | error
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    const email = form.email.trim().toLowerCase()
    if (!email) return

    setStatus('submitting')
    try {
      // 重複チェック
      const snap = await getDocs(query(
        collection(db, 'nl_readers'),
        where('email', '==', email),
      ))
      if (!snap.empty) {
        setStatus('duplicate')
        return
      }

      await addDoc(collection(db, 'nl_readers'), {
        email,
        name: form.name.trim(),
        company: form.company.trim(),
        type: form.type,
        status: 'active',
        source: 'form',
        // 同意を証する記録（特定電子メール法）
        consentedAt: serverTimestamp(),
        consentMethod: 'web_form',
        consentSource: window.location.href,
        consentNote: 'メルマガ登録フォームより本人が登録',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })

      setStatus('done')
    } catch (err) {
      console.error('登録エラー:', err)
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <div className="mb-4 text-5xl">✅</div>
        <h1 className="mb-3 text-2xl font-bold text-gray-900">登録完了</h1>
        <p className="text-gray-600">
          メルマガの登録が完了しました。<br />
          今後、最新情報をお届けいたします。
        </p>
        <p className="mt-6 text-xs text-gray-400">
          配信を停止したい場合は、メール内の配信解除リンクからいつでも解除できます。
        </p>
      </div>
    )
  }

  if (status === 'duplicate') {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <div className="mb-4 text-5xl">📧</div>
        <h1 className="mb-3 text-2xl font-bold text-gray-900">登録済みです</h1>
        <p className="text-gray-600">
          このメールアドレスは既に登録されています。
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">メルマガ登録</h1>
        <p className="mt-2 text-sm text-gray-500">
          VAVITTE（バビッテ）の最新情報・キャンペーン情報をお届けします
        </p>
      </div>

      <form onSubmit={handleSubmit} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              メールアドレス <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="example@salon.com"
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">お名前</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="山田 太郎"
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">会社名 / サロン名</label>
            <input
              type="text"
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
              placeholder="〇〇サロン"
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">種別</label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
            >
              <option value="salon">サロン</option>
              <option value="dealer">代理店</option>
            </select>
          </div>
        </div>

        {status === 'error' && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            登録に失敗しました: {errorMsg}
          </div>
        )}

        <div className="mt-6">
          <button
            type="submit"
            disabled={status === 'submitting'}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {status === 'submitting' ? '登録中...' : 'メルマガに登録する'}
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-gray-400">
          ご登録いただいた情報はメルマガ配信のみに使用いたします。<br />
          配信停止はメール内のリンクからいつでも可能です。
        </p>
      </form>
    </div>
  )
}
