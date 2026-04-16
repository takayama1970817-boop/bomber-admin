import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  collection, getDocs, query, where, updateDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../../lib/firebase.js'

/**
 * 公開メルマガ配信解除フォーム（認証不要）
 * URL: /newsletter/unsubscribe?email=xxx@example.com
 *
 * メール本文に解除リンクを埋め込む：
 * https://bomber-admin.web.app/newsletter/unsubscribe?email={email}
 */
export default function NewsletterUnsubscribe() {
  const [params] = useSearchParams()
  const prefillEmail = params.get('email') || ''

  const [email, setEmail] = useState(prefillEmail)
  const [status, setStatus] = useState('idle') // idle | submitting | done | notfound | error
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) return

    setStatus('submitting')
    try {
      const snap = await getDocs(query(
        collection(db, 'nl_readers'),
        where('email', '==', trimmed),
      ))
      if (snap.empty) {
        setStatus('notfound')
        return
      }

      // 全一致ドキュメントを解除済みに更新
      for (const d of snap.docs) {
        await updateDoc(doc(db, 'nl_readers', d.id), {
          status: 'unsubscribed',
          unsubscribedAt: serverTimestamp(),
          unsubscribeMethod: 'web_form',
          updatedAt: serverTimestamp(),
        })
      }

      setStatus('done')
    } catch (err) {
      console.error('解除エラー:', err)
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <div className="mb-4 text-5xl">📭</div>
        <h1 className="mb-3 text-2xl font-bold text-gray-900">配信解除完了</h1>
        <p className="text-gray-600">
          メルマガの配信を停止しました。<br />
          今後、メールは届きません。
        </p>
        <p className="mt-6 text-xs text-gray-400">
          再登録をご希望の場合は、登録フォームから再度お申し込みください。
        </p>
      </div>
    )
  }

  if (status === 'notfound') {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <div className="mb-4 text-5xl">🤔</div>
        <h1 className="mb-3 text-2xl font-bold text-gray-900">登録が見つかりません</h1>
        <p className="text-gray-600">
          入力されたメールアドレスはメルマガに登録されていません。
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="mt-6 rounded-lg border border-gray-300 px-6 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          戻る
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">メルマガ配信解除</h1>
        <p className="mt-2 text-sm text-gray-500">
          以下にメールアドレスを入力して配信を停止できます
        </p>
      </div>

      <form onSubmit={handleSubmit} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            メールアドレス <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="example@salon.com"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {status === 'error' && (
          <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            解除に失敗しました: {errorMsg}
          </div>
        )}

        <div className="mt-6">
          <button
            type="submit"
            disabled={status === 'submitting'}
            className="w-full rounded-lg bg-gray-800 py-3 text-sm font-bold text-white hover:bg-gray-900 disabled:opacity-50"
          >
            {status === 'submitting' ? '処理中...' : '配信を解除する'}
          </button>
        </div>
      </form>
    </div>
  )
}
