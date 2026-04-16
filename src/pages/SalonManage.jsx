import { useEffect, useState } from 'react'
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  deleteDoc,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'

const APP_URL = 'https://bomber-admin.web.app'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export default function SalonManage() {
  const [accounts, setAccounts] = useState([])
  const [dealers, setDealers] = useState([])
  const [loading, setLoading] = useState(true)

  // 単体招待
  const [invEmail, setInvEmail] = useState('')
  const [invSalonName, setInvSalonName] = useState('')
  const [invCompany, setInvCompany] = useState('')
  const [invDealerCode, setInvDealerCode] = useState('')
  const [invSubRole, setInvSubRole] = useState('') // 必須、未選択不可
  const [inviting, setInviting] = useState(false)
  const [invMsg, setInvMsg] = useState('')

  // 一括招待
  const [bulkText, setBulkText] = useState('')
  const [bulkDealerCode, setBulkDealerCode] = useState('')
  const [bulkSubRole, setBulkSubRole] = useState('') // 必須、未選択不可（今回追加する全員の権限）
  const [bulkResults, setBulkResults] = useState(null)
  const [bulkLoading, setBulkLoading] = useState(false)

  const loadData = async () => {
    try {
      const snap = await getDocs(collection(db, 'allowedEmails'))
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      setAccounts(all.filter((a) => a.role === 'salon'))
      setDealers(all.filter((a) => a.role === 'dealer' && a.dealerCode))
    } catch (e) {
      console.error('データ取得エラー:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  // 単体招待
  const handleInvite = async () => {
    const email = invEmail.trim().toLowerCase()
    const salonName = invSalonName.trim()
    const company = invCompany.trim()

    if (!email || !company) {
      alert('メールアドレスと会社名（サロン名）は必須です')
      return
    }
    if (invSubRole !== 'admin' && invSubRole !== 'staff') {
      alert('権限（管理者 / スタッフ）を選択してください')
      return
    }

    setInviting(true)
    setInvMsg('')
    try {
      const ref = doc(collection(db, 'allowedEmails'))
      await setDoc(ref, {
        email,
        salonName: salonName || company,
        companyName: company,
        dealerCode: invDealerCode.trim().toUpperCase() || '',
        role: 'salon',
        subRole: invSubRole, // 必須バリデーション済
        invitedAt: serverTimestamp(),
        loggedIn: false,
      })

      setInvMsg(`${company} を登録しました`)
      setInvEmail('')
      setInvSalonName('')
      setInvCompany('')
      setInvDealerCode('')
      await loadData()
    } catch (e) {
      console.error(e)
      alert('登録に失敗しました: ' + (e?.message || ''))
    } finally {
      setInviting(false)
    }
  }

  // 一括招待
  const handleBulkInvite = async () => {
    const lines = bulkText.trim().split('\n').filter(Boolean)
    if (lines.length === 0) { alert('データを入力してください'); return }

    // 権限の必須バリデーション（UI + 保存処理の二重防御）
    if (bulkSubRole !== 'admin' && bulkSubRole !== 'staff') {
      alert('今回追加する全員の権限（管理者 / スタッフ）を選択してください')
      return
    }

    setBulkLoading(true)
    setBulkResults(null)
    let success = 0
    let skip = 0
    const errors = []

    // 既存メールアドレス一覧
    const existingEmails = new Set(accounts.map((a) => a.email?.toLowerCase()))

    for (const line of lines) {
      // CSV形式：メールアドレス,会社名,サロン名（任意）
      // TODO(future): 4列目に権限（admin/staff）を受け取る拡張余地あり。現状は一括選択のみサポート
      const parts = line.split(/[,\t]/).map((s) => s.trim())
      const email = (parts[0] || '').toLowerCase()
      const company = parts[1] || ''
      const salonName = parts[2] || company

      if (!email || !company) {
        errors.push(`無効な行: ${line}`)
        continue
      }
      if (existingEmails.has(email)) {
        skip++
        continue
      }

      try {
        const ref = doc(collection(db, 'allowedEmails'))
        await setDoc(ref, {
          email,
          salonName,
          companyName: company,
          dealerCode: bulkDealerCode.trim().toUpperCase() || '',
          role: 'salon',
          subRole: bulkSubRole, // 一括指定（必須）
          invitedAt: serverTimestamp(),
          loggedIn: false,
        })
        existingEmails.add(email)
        success++
      } catch (e) {
        errors.push(`${email}: ${e.message}`)
      }
    }

    // 取込ログに appliedSubRole を含める
    setBulkResults({ success, skip, errors, appliedSubRole: bulkSubRole })
    setBulkLoading(false)
    await loadData()
  }

  // 削除
  const handleDelete = async (id, name) => {
    if (!window.confirm(`「${name}」のサロンアカウントを削除しますか？`)) return
    try {
      await deleteDoc(doc(db, 'allowedEmails', id))
      await loadData()
    } catch (e) {
      console.error(e)
      alert('削除に失敗しました')
    }
  }

  // メルマガ用テキスト生成
  const handleGenerateMailText = () => {
    const subject = '【VAVITTE】サロン専用ポータルのご案内'
    const body = `いつもVAVITTE製品をご愛用いただきありがとうございます。\n\nこの度、サロン様専用のポータルサイトをご用意いたしました。\n注文履歴の確認や、販促資料のダウンロード、担当者とのチャットがご利用いただけます。\n\n▼ ログインURL\n${APP_URL}/salon-login\n\n※ 初めてログインされる方は、このメールを受信したメールアドレスと、お好きなパスワードを入力してください。\n※ アカウントが自動で作成されます。\n※ Googleアカウントでのログインも可能です。\n\nご不明な点がございましたらお気軽にお問い合わせください。`

    const params = new URLSearchParams({ view: 'cm', fs: '1', su: subject, body })
    window.open(`https://mail.google.com/mail/?${params.toString()}`, '_blank', 'noopener,noreferrer')
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">読み込み中...</div>
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">サロンアカウント管理</h1>
      <p className="mb-6 text-sm text-gray-500">
        登録済み {accounts.length} サロン
      </p>

      {/* メルマガ用ボタン */}
      <div className="mb-6">
        <button
          onClick={handleGenerateMailText}
          className="rounded-lg bg-pink-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-pink-700"
        >
          メルマガ用の案内文を作成（Gmail）
        </button>
        <p className="mt-2 text-xs text-gray-400">
          Gmailの作成画面が開きます。BCCにサロンのメールアドレスを貼り付けて送信してください。
        </p>
      </div>

      {/* 単体招待 */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold text-gray-700">サロンを1件追加</h2>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="会社名 / サロン名（必須）"
            value={invCompany}
            onChange={(e) => setInvCompany(e.target.value)}
            className="w-52 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
          />
          <input
            type="email"
            placeholder="メールアドレス（必須）"
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
          />
          <select
            value={invDealerCode}
            onChange={(e) => setInvDealerCode(e.target.value)}
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
          >
            <option value="">紐付け代理店（任意）</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.dealerCode}>
                {d.dealerCode} — {d.companyName}
              </option>
            ))}
          </select>
          <select
            value={invSubRole}
            onChange={(e) => setInvSubRole(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm focus:outline-none ${
              invSubRole ? 'border-gray-300 focus:border-pink-500' : 'border-red-400 bg-red-50 focus:border-red-500'
            }`}
            title="招待する人の権限（必須）"
          >
            <option value="">権限を選択（必須）</option>
            <option value="admin">管理者（全権）</option>
            <option value="staff">スタッフ（閲覧のみ）</option>
          </select>
          <button
            onClick={handleInvite}
            disabled={inviting}
            className="rounded-lg bg-pink-600 px-5 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
          >
            {inviting ? '登録中...' : '追加する'}
          </button>
        </div>
        {invMsg && (
          <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{invMsg}</div>
        )}
      </div>

      {/* 一括招待 */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold text-gray-700">一括登録（CSV / タブ区切り）</h2>
        <p className="mb-3 text-xs text-gray-500">
          1行に「メールアドレス, 会社名, サロン名（任意）」の形式で入力してください。
        </p>
        <textarea
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          rows={6}
          placeholder={`salon1@example.com,ビューティーサロンA\nsalon2@example.com,ビューティーサロンB,サロンB支店`}
          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-pink-500 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={bulkDealerCode}
            onChange={(e) => setBulkDealerCode(e.target.value)}
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-pink-500 focus:outline-none"
          >
            <option value="">紐付け代理店（一括）</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.dealerCode}>
                {d.dealerCode} — {d.companyName}
              </option>
            ))}
          </select>
          <select
            value={bulkSubRole}
            onChange={(e) => setBulkSubRole(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm focus:outline-none ${
              bulkSubRole ? 'border-gray-300 focus:border-pink-500' : 'border-red-400 bg-red-50 focus:border-red-500'
            }`}
            title="今回追加する全員の権限（必須）"
          >
            <option value="">今回追加する全員の権限（必須）</option>
            <option value="admin">管理者（全権）</option>
            <option value="staff">スタッフ（閲覧のみ）</option>
          </select>
          <button
            onClick={handleBulkInvite}
            disabled={bulkLoading}
            className="rounded-lg bg-pink-600 px-5 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-50"
          >
            {bulkLoading ? '処理中...' : '一括登録'}
          </button>
        </div>
        {bulkResults && (
          <div className="mt-3 rounded-lg bg-gray-50 px-4 py-3 text-sm">
            <div className="text-green-700">
              登録成功：{bulkResults.success}件
              {bulkResults.appliedSubRole && (
                <span className="ml-2 rounded bg-pink-100 px-2 py-0.5 text-[11px] font-medium text-pink-700">
                  権限={bulkResults.appliedSubRole === 'admin' ? '管理者' : 'スタッフ'}
                </span>
              )}
            </div>
            {bulkResults.skip > 0 && <div className="text-yellow-700">重複スキップ：{bulkResults.skip}件</div>}
            {bulkResults.errors.length > 0 && (
              <div className="mt-1 text-red-600">
                {bulkResults.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 登録済みサロン一覧 */}
      {accounts.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-bold text-gray-600">
            登録済みサロン（{accounts.length}件）
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                  <th className="px-4 py-2">サロン名</th>
                  <th className="px-4 py-2">会社名</th>
                  <th className="px-4 py-2">メール</th>
                  <th className="px-4 py-2">代理店</th>
                  <th className="px-4 py-2">登録日</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">{a.salonName || '—'}</td>
                    <td className="px-4 py-2 text-gray-600">{a.companyName || '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{a.email}</td>
                    <td className="px-4 py-2 font-mono text-xs text-indigo-600">{a.dealerCode || '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-400">{fmtDate(a.invitedAt)}</td>
                    <td className="px-4 py-2">
                      <button
                        onClick={() => handleDelete(a.id, a.salonName || a.companyName)}
                        className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
