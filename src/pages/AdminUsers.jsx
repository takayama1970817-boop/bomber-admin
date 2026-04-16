import { useEffect, useState } from 'react'
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { createAccountWithoutSignout } from '../lib/createAccountWithoutSignout.js'

const ymToRange = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const nextM = m === 12 ? '01' : String(m + 1).padStart(2, '0')
  const nextY = m === 12 ? y + 1 : y
  const end = `${nextY}-${nextM}-01`
  return [start, end]
}

const currentMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const fmtTime = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

const APP_URL = 'https://bomber-admin.web.app'

// 安全で読みやすいランダムパスワードを生成（混同しやすい文字 0,O,l,1,I を除外）
function generatePassword(length = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digit = '23456789'
  const symbol = '!@#$%&*'
  const all = upper + lower + digit + symbol
  // 各カテゴリから最低1文字を保証
  const required = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digit[Math.floor(Math.random() * digit.length)],
    symbol[Math.floor(Math.random() * symbol.length)],
  ]
  const remaining = Array.from({ length: length - required.length }, () =>
    all[Math.floor(Math.random() * all.length)]
  )
  return [...required, ...remaining].sort(() => Math.random() - 0.5).join('')
}

export default function AdminUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedUid, setSelectedUid] = useState(null)
  const [month, setMonth] = useState(currentMonth())
  const [attendance, setAttendance] = useState([])
  const [attLoading, setAttLoading] = useState(false)

  // 招待用
  const [allowedEmails, setAllowedEmails] = useState([])
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [loginMethod, setLoginMethod] = useState('google') // 'google' or 'password'
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const [userSnap, allowSnap] = await Promise.all([
          getDocs(collection(db, 'users')),
          getDocs(collection(db, 'allowedEmails')),
        ])
        setUsers(userSnap.docs.map((d) => ({ uid: d.id, ...d.data() })))
        setAllowedEmails(
          allowSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        )
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!selectedUid) {
      setAttendance([])
      return
    }
    ;(async () => {
      setAttLoading(true)
      try {
        const [start, end] = ymToRange(month)
        const q = query(
          collection(db, 'attendance'),
          where('uid', '==', selectedUid),
          where('date', '>=', start),
          where('date', '<', end),
          orderBy('date'),
        )
        const snap = await getDocs(q)
        setAttendance(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      } catch (e) {
        console.error(e)
      } finally {
        setAttLoading(false)
      }
    })()
  }, [selectedUid, month])

  const changeRole = async (uid, role) => {
    if (
      !confirm(
        `${uid} の権限を ${role} に変更します。よろしいですか？`,
      )
    )
      return
    try {
      await updateDoc(doc(db, 'users', uid), { role })
      setUsers((us) => us.map((u) => (u.uid === uid ? { ...u, role } : u)))
    } catch (e) {
      console.error(e)
      alert('変更に失敗しました: ' + (e?.code || e?.message || ''))
    }
  }

  const updateBreakMinutes = async (recordId, newValue) => {
    const v = Number(newValue)
    if (Number.isNaN(v) || v < 0) return
    try {
      await updateDoc(doc(db, 'attendance', recordId), { breakMinutes: v })
      setAttendance((rows) =>
        rows.map((r) => (r.id === recordId ? { ...r, breakMinutes: v } : r)),
      )
    } catch (e) {
      console.error(e)
      alert('更新失敗: ' + (e?.code || e?.message || ''))
    }
  }

  // スタッフ招待（手動登録 + 招待メール）
  const handleInvite = async () => {
    const email = newEmail.trim().toLowerCase()
    const name = newName.trim()

    if (!email) {
      alert('メールアドレスを入力してください')
      return
    }
    if (!email.includes('@')) {
      alert('正しいメールアドレスを入力してください')
      return
    }

    // 重複チェック
    if (allowedEmails.some((a) => a.email === email)) {
      alert('このメールアドレスは既に登録されています')
      return
    }

    // パスワード方式の場合はパスワード必須
    const password = newPassword.trim()
    if (loginMethod === 'password') {
      if (!password || password.length < 6) {
        alert('パスワードは6文字以上で入力してください')
        return
      }
    }

    setInviting(true)
    setInviteMsg('')
    try {
      // パスワード方式の場合、Firebase Authにアカウント作成
      if (loginMethod === 'password') {
        try {
          await createAccountWithoutSignout(email, password)
        } catch (authErr) {
          if (authErr.code === 'auth/email-already-in-use') {
            // 既にAuthアカウントがあればスキップ（allowedEmailsへの追加のみ行う）
            console.warn('Authアカウントは既に存在します、allowedEmailsのみ登録します')
          } else {
            throw authErr
          }
        }
      }

      const ref = doc(collection(db, 'allowedEmails'))
      const data = {
        email,
        name: name || '',
        role: 'staff',
        loginMethod, // 'google' or 'password'
        invitedAt: serverTimestamp(),
        loggedIn: false,
      }
      await setDoc(ref, data)
      setAllowedEmails((prev) => [...prev, { id: ref.id, ...data }])

      // Gmail 招待メール下書きを開く
      const subject = '【ロイヤルトラスト】社内システムへの招待'
      const body = loginMethod === 'password'
        ? `${name ? name + ' さん\n\n' : ''}ロイヤルトラストの社内システムに招待されました。\n\n下記のURLからメールアドレスとパスワードでログインしてください。\n\n▼ ログインURL\n${APP_URL}\n\n▼ ログイン情報\nメールアドレス: ${email}\nパスワード: ${password}\n\n※ 初回ログイン後、パスワードは変更することをおすすめします。\n\nご不明な点があればお気軽にご連絡ください。`
        : `${name ? name + ' さん\n\n' : ''}ロイヤルトラストの社内システムに招待されました。\n\n下記のURLからGoogleアカウントでログインしてください。\n\n▼ ログインURL\n${APP_URL}\n\n※ このメールに記載のGoogleアカウント（${email}）でログインしてください。\n※ 他のアカウントではログインできません。\n\nご不明な点があればお気軽にご連絡ください。`

      const params = new URLSearchParams({
        view: 'cm',
        fs: '1',
        to: email,
        su: subject,
        body,
      })
      window.open(
        `https://mail.google.com/mail/?${params.toString()}`,
        '_blank',
        'noopener,noreferrer',
      )

      setInviteMsg(`✅ ${email} を登録しました（${loginMethod === 'password' ? 'メール＋パスワード' : 'Googleアカウント'}方式）。Gmailの下書きが開きます。`)
      setNewName('')
      setNewEmail('')
      setNewPassword('')
    } catch (e) {
      console.error(e)
      alert('登録に失敗しました: ' + (e?.code || e?.message || ''))
    } finally {
      setInviting(false)
    }
  }

  // 許可メール削除（アクセス取り消し）
  const handleRevoke = async (item) => {
    if (
      !confirm(
        `${item.email} のアクセスを取り消します。\nこのスタッフはログインできなくなります。よろしいですか？`,
      )
    )
      return
    try {
      await deleteDoc(doc(db, 'allowedEmails', item.id))
      setAllowedEmails((prev) => prev.filter((a) => a.id !== item.id))
    } catch (e) {
      console.error(e)
      alert('削除に失敗しました')
    }
  }

  // ログイン済みかどうか
  const isLoggedIn = (email) =>
    users.some((u) => u.email?.toLowerCase() === email?.toLowerCase())

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">スタッフ管理</h1>

      {/* スタッフ招待セクション */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          スタッフを招待する
        </h2>

        {/* ログイン方式の切替タブ */}
        <div className="mb-4 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            onClick={() => setLoginMethod('google')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              loginMethod === 'google'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Googleアカウント
          </button>
          <button
            onClick={() => setLoginMethod('password')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              loginMethod === 'password'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            メール＋パスワード
          </button>
        </div>

        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="名前（例：山田 太郎）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="email"
            placeholder={loginMethod === 'google' ? 'メールアドレス（Google）' : 'メールアドレス'}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
            className="w-72 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          {loginMethod === 'password' && (
            <>
              <input
                type="text"
                placeholder="初期パスワード（6文字以上）"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setNewPassword(generatePassword(12))}
                className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
                title="12文字のランダムパスワードを生成"
              >
                🎲 自動生成
              </button>
            </>
          )}
          <button
            onClick={handleInvite}
            disabled={inviting}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {inviting ? '登録中...' : '📧 招待する'}
          </button>
        </div>
        {inviteMsg && (
          <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            {inviteMsg}
          </div>
        )}
        <p className="mt-3 text-xs text-gray-400">
          {loginMethod === 'google'
            ? '登録したメールアドレスのGoogleアカウントでのみログイン可能になります。招待メールがGmailで自動作成されます。'
            : '登録したメールアドレスと初期パスワードでログイン可能になります。Firebase Authアカウントを自動作成し、ログイン情報を含む招待メールがGmailで自動作成されます。'}
        </p>
      </div>

      {/* 許可メール一覧 */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-semibold uppercase text-gray-500">
          アクセス許可一覧（{allowedEmails.length}件）
        </div>
        {loading ? (
          <div className="px-4 py-6 text-center text-gray-400">
            読み込み中...
          </div>
        ) : allowedEmails.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            まだ誰も登録されていません。上のフォームからスタッフを招待してください。
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">名前</th>
                <th className="px-4 py-2">メールアドレス</th>
                <th className="px-4 py-2">状態</th>
                <th className="px-4 py-2">権限</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {allowedEmails.map((item) => (
                <tr key={item.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-900">
                    {item.name || '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{item.email}</td>
                  <td className="px-4 py-2">
                    {isLoggedIn(item.email) ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                        ログイン済
                      </span>
                    ) : (
                      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                        未ログイン
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {item.role || 'staff'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => handleRevoke(item)}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      取り消し
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左：スタッフ一覧 */}
        <div className="lg:col-span-1">
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-semibold uppercase text-gray-500">
              ログイン済みスタッフ
            </div>
            {loading ? (
              <div className="px-4 py-6 text-center text-gray-400">
                読み込み中...
              </div>
            ) : (
              users.map((u) => (
                <div
                  key={u.uid}
                  onClick={() => setSelectedUid(u.uid)}
                  className={`cursor-pointer border-t border-gray-100 px-4 py-3 hover:bg-gray-50 ${
                    selectedUid === u.uid ? 'bg-indigo-50' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {u.name || '—'}
                      </div>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </div>
                    <select
                      value={u.role || 'staff'}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => changeRole(u.uid, e.target.value)}
                      className={`rounded border px-2 py-1 text-xs ${
                        u.role === 'master' ? 'border-red-300 bg-red-50 text-red-700'
                        : u.role === 'admin' ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : u.role === 'dealer' ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : u.role === 'salon' ? 'border-pink-300 bg-pink-50 text-pink-700'
                        : u.role === 'warehouse' ? 'border-gray-400 bg-gray-100 text-gray-700'
                        : u.role === 'client' ? 'border-amber-300 bg-amber-50 text-amber-700'
                        : 'border-gray-300'
                      }`}
                    >
                      <option value="master">マスター</option>
                      <option value="admin">管理者</option>
                      <option value="staff">社内スタッフ</option>
                      <option value="dealer">代理店</option>
                      <option value="salon">サロン</option>
                      <option value="client">取引先</option>
                      <option value="warehouse">倉庫</option>
                    </select>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右：選択したスタッフの勤怠修正 */}
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-3">
              <div className="text-xs font-semibold uppercase text-gray-500">
                勤怠の確認・修正
              </div>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-xs"
              />
            </div>

            {!selectedUid ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                左からスタッフを選択してください
              </div>
            ) : attLoading ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                読み込み中...
              </div>
            ) : attendance.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                データがありません
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">日付</th>
                    <th className="px-3 py-2">出勤</th>
                    <th className="px-3 py-2">退勤</th>
                    <th className="px-3 py-2">休憩(分)</th>
                  </tr>
                </thead>
                <tbody>
                  {attendance.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="px-3 py-2">{r.date}</td>
                      <td className="px-3 py-2">{fmtTime(r.clockIn)}</td>
                      <td className="px-3 py-2">{fmtTime(r.clockOut)}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          defaultValue={r.breakMinutes ?? 0}
                          onBlur={(e) =>
                            updateBreakMinutes(r.id, e.target.value)
                          }
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-xs"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
