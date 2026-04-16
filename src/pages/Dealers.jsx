import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { signInWithCustomToken } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../lib/firebase.js'
import { createAccountWithoutSignout } from '../lib/createAccountWithoutSignout.js'
import { signInExisting } from '../lib/createAccountWithoutSignout.js'
import { downloadKbRulesXlsx } from '../lib/generateKbRulesXlsx.js'
import { downloadKbRulesPdf } from '../lib/generateKbRulesPdf.js'

const APP_URL = 'https://bomber-admin.web.app'

function fmtDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtYen(n) {
  if (n == null) return '—'
  return '¥' + Number(n).toLocaleString()
}

export default function Dealers() {
  const navigate = useNavigate()
  const [dealers, setDealers] = useState([])
  const [dealerAccounts, setDealerAccounts] = useState([]) // allowedEmails role=dealer
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [orders, setOrders] = useState([])
  const [allOrders, setAllOrders] = useState([])
  const [sortKey, setSortKey] = useState('total')
  const [sortAsc, setSortAsc] = useState(false)

  // 全注文 + 代理店アカウントを取得
  useEffect(() => {
    ;(async () => {
      try {
        const [orderSnap, emailSnap] = await Promise.all([
          getDocs(query(collection(db, 'orders'), orderBy('orderDate', 'desc'))),
          getDocs(collection(db, 'allowedEmails')),
        ])
        const all = orderSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        setAllOrders(all)
        setDealerAccounts(
          emailSnap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((d) => d.role === 'dealer' && d.dealerCode),
        )

        // 代理店ごとに集計
        const map = {}
        for (const o of all) {
          const name = o.companyName || '（会社名なし）'
          if (!map[name]) {
            map[name] = {
              name,
              count: 0,
              total: 0,
              lastOrder: null,
              lastOrderDate: null,
            }
          }
          map[name].count++
          map[name].total += Number(o.total) || 0
          const oDate = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
          if (oDate && (!map[name].lastOrderDate || oDate > map[name].lastOrderDate)) {
            map[name].lastOrderDate = oDate
            map[name].lastOrder = o.orderDate
          }
        }

        setDealers(Object.values(map))
      } catch (e) {
        console.error('注文データ取得エラー:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ソート
  const sorted = [...dealers].sort((a, b) => {
    let cmp = 0
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name, 'ja')
    else if (sortKey === 'count') cmp = a.count - b.count
    else if (sortKey === 'total') cmp = a.total - b.total
    else if (sortKey === 'lastOrder') cmp = (a.lastOrderDate || 0) - (b.lastOrderDate || 0)
    return sortAsc ? cmp : -cmp
  })

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  const sortIcon = (key) => {
    if (sortKey !== key) return ''
    return sortAsc ? ' ↑' : ' ↓'
  }

  // === 代理店招待 ===
  const [invName, setInvName] = useState('')
  const [invEmail, setInvEmail] = useState('')
  const [invCompany, setInvCompany] = useState('')
  const [invCode, setInvCode] = useState('')
  const [invSubRole, setInvSubRole] = useState('') // '' | 'admin' | 'staff' (必須、未選択不可)
  const [inviting, setInviting] = useState(false)
  const [invMsg, setInvMsg] = useState('')

  const handleDealerInvite = async () => {
    const email = invEmail.trim().toLowerCase()
    const name = invName.trim()
    const company = invCompany.trim()
    const code = invCode.trim().toUpperCase()

    if (!email || !company || !code) {
      alert('代理店コード・会社名・メールアドレスは必須です')
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
        name: name || '',
        companyName: company,
        dealerCode: code,
        role: 'dealer',
        subRole: invSubRole, // 'admin' | 'staff'（必須バリデーション済）
        invitedAt: serverTimestamp(),
        loggedIn: false,
      })

      // Gmail 招待メール
      const subject = '【VAVITTE】代理店ポータルへの招待'
      const body = `${company}　${name ? name + ' 様' : '御中'}\n\nいつもお世話になっております。\nVAVITTE代理店専用ポータルをご案内いたします。\n\n下記URLからGoogleアカウントでログインしてください。\n\n▼ ログインURL\n${APP_URL}\n\n※ このメールに記載のGoogleアカウント（${email}）でログインしてください。\n※ ログイン後、貴社の注文履歴・売上をご確認いただけます。\n\nご不明な点がございましたらお気軽にお問い合わせください。`

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

      setInvMsg(`✅ ${company}（${code}）を代理店として登録しました`)
      setInvName('')
      setInvEmail('')
      setInvCode('')
      setInvCompany('')
    } catch (e) {
      console.error(e)
      alert('登録に失敗しました: ' + (e?.message || ''))
    } finally {
      setInviting(false)
    }
  }

  // === 代理店アカウント直接作成 ===
  const [createCompany, setCreateCompany] = useState('')
  const [createCode, setCreateCode] = useState('')
  const [createName, setCreateName] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createSubRole, setCreateSubRole] = useState('') // 必須、未選択不可
  const [creating, setCreating] = useState(false)
  const [createMsg, setCreateMsg] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)

  const generatePassword = () => {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
    let pw = ''
    for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)]
    setCreatePassword(pw)
  }

  const handleCreateAccount = async () => {
    const email = createEmail.trim().toLowerCase()
    const company = createCompany.trim()
    const code = createCode.trim().toUpperCase()
    const name = createName.trim()
    const password = createPassword.trim()

    if (!email || !company || !code || !password) {
      alert('会社名・代理店コード・メールアドレス・パスワードは必須です')
      return
    }
    if (password.length < 6) {
      alert('パスワードは6文字以上で設定してください')
      return
    }
    if (createSubRole !== 'admin' && createSubRole !== 'staff') {
      alert('権限（管理者 / スタッフ）を選択してください')
      return
    }

    setCreating(true)
    setCreateMsg('')
    try {
      let uid

      // 1. Firebase Auth でアカウント作成（管理者はサインアウトされない）
      try {
        uid = await createAccountWithoutSignout(email, password)
      } catch (authErr) {
        if (authErr.code === 'auth/email-already-in-use') {
          // 既存AuthユーザーにサインインしてUID取得
          try {
            uid = await signInExisting(email, password)
          } catch {
            throw new Error('このメールアドレスは既に登録済みです。同じパスワードを入力するか、Firebaseコンソールで該当ユーザーを削除してください。')
          }
        } else {
          throw authErr
        }
      }

      // 2. allowedEmails に登録
      const allowRef = doc(collection(db, 'allowedEmails'))
      await setDoc(allowRef, {
        email,
        name: name || '',
        companyName: company,
        dealerCode: code,
        role: 'dealer',
        subRole: createSubRole, // 必須バリデーション済
        invitedAt: serverTimestamp(),
        loggedIn: false,
      })

      // 3. users ドキュメント作成
      await setDoc(doc(db, 'users', uid), {
        uid,
        name: name || company,
        email,
        role: 'dealer',
        subRole: createSubRole, // 必須バリデーション済
        companyName: company,
        dealerCode: code,
        createdAt: serverTimestamp(),
      })

      setCreateMsg(`✅ ${company}（${code}）のアカウントを作成しました\nメール：${email}\nパスワード：${password}`)
      setDealerAccounts((prev) => [...prev, { id: allowRef.id, email, name, companyName: company, dealerCode: code, role: 'dealer' }])
      setCreateCompany('')
      setCreateCode('')
      setCreateName('')
      setCreateEmail('')
      setCreatePassword('')
    } catch (e) {
      console.error(e)
      alert('アカウント作成に失敗しました: ' + (e?.message || ''))
    } finally {
      setCreating(false)
    }
  }

  // === 代理店に成り代わってログイン（閲覧モード） ===
  const [impersonating, setImpersonating] = useState(null) // email being impersonated

  const handleImpersonate = async (d) => {
    const ok = window.confirm(
      `${d.companyName}（${d.dealerCode}）の代理店画面を閲覧モードで開きますか？\n\n` +
      `※ 現在の管理者アカウントはログアウトされます。\n` +
      `※ 書き込み操作はブロックされます（閲覧・確認のみ）。\n` +
      `※ 元の管理者に戻るには、代理店画面上部の「管理者に戻る」を押してください。`,
    )
    if (!ok) return
    setImpersonating(d.email)
    try {
      const fn = httpsCallable(functions, 'impersonateDealer')
      const res = await fn({ dealerEmail: d.email })
      await signInWithCustomToken(auth, res.data.token)
      navigate('/dealer')
    } catch (e) {
      console.error(e)
      alert('成り代わりに失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setImpersonating(null)
    }
  }

  // === 代理店削除 ===
  const [deleting, setDeleting] = useState(null) // email being deleted
  const [deleteConfirm, setDeleteConfirm] = useState(null) // 削除確認中の代理店

  const handleDeleteDealer = async (d) => {
    setDeleting(d.email)
    try {
      // allowedEmails を削除（ログイン不可になる）
      await deleteDoc(doc(db, 'allowedEmails', d.id))

      // users コレクションからも削除（emailで検索）
      const usersSnap = await getDocs(query(collection(db, 'users'), where('email', '==', d.email)))
      for (const u of usersSnap.docs) {
        await deleteDoc(doc(db, 'users', u.id))
      }

      setDealerAccounts((prev) => prev.filter((a) => a.id !== d.id))
      setDeleteConfirm(null)
      alert(`${d.companyName} のアカウントを削除しました`)
    } catch (e) {
      console.error(e)
      alert('削除に失敗しました: ' + (e?.message || ''))
    } finally {
      setDeleting(null)
    }
  }

  // === 代理店情報編集 ===
  const [editingDealer, setEditingDealer] = useState(null)
  const [editSaving, setEditSaving] = useState(false)

  const startEditDealer = (d) => {
    setEditingDealer({
      id: d.id,
      dealerCode: d.dealerCode,
      companyName: d.companyName || '',
      name: d.name || '',
      email: d.email || '',
      invoiceEmail: d.invoiceEmail || '',
      address: d.address || '',
      phone: d.phone || '',
      representative: d.representative || '',
      paymentMethod: d.paymentMethod || '',
      fax: d.fax || '',
      founded: d.founded || '',
      revenue: d.revenue || '',
      industry: d.industry || '',
      website: d.website || '',
      bcartId: d.bcartId || '',
      kbGroup: d.kbGroup || 'A',
      kbRate: d.kbRate ?? '',
      includeOwnOrders: d.includeOwnOrders || false,
      notes: d.notes || '',
      fixedAdjustments: d.fixedAdjustments || [],
      bankInfo: {
        bankName: d.bankInfo?.bankName || '',
        branchName: d.bankInfo?.branchName || '',
        accountType: d.bankInfo?.accountType || '普通',
        accountNumber: d.bankInfo?.accountNumber || '',
        accountHolder: d.bankInfo?.accountHolder || '',
      },
    })
  }

  const saveEditDealer = async () => {
    if (!editingDealer) return
    setEditSaving(true)
    try {
      const { id, ...data } = editingDealer
      await updateDoc(doc(db, 'allowedEmails', id), data)
      setDealerAccounts((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, ...data } : d,
        ),
      )
      setEditingDealer(null)
      alert('保存しました')
    } catch (e) {
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setEditSaving(false)
    }
  }

  // 代理店クリック → 注文一覧表示
  const selectDealer = (name) => {
    setSelected(name)
    setOrders(allOrders.filter((o) => (o.companyName || '（会社名なし）') === name))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        読み込み中...
      </div>
    )
  }

  // 代理店詳細（注文一覧）
  if (selected) {
    const dealer = dealers.find((d) => d.name === selected)
    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="mb-4 text-sm text-indigo-600 hover:underline"
        >
          ← 代理店一覧に戻る
        </button>

        <h1 className="mb-1 text-2xl font-bold text-gray-900">{selected}</h1>
        <div className="mb-6 flex gap-6 text-sm text-gray-500">
          <span>注文数：<strong className="text-gray-900">{dealer?.count || 0}件</strong></span>
          <span>累計売上：<strong className="text-gray-900">{fmtYen(dealer?.total)}</strong></span>
          <span>最終注文：<strong className="text-gray-900">{fmtDate(dealer?.lastOrder)}</strong></span>
        </div>

        {/* 月別集計 */}
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-bold text-gray-700">月別売上</h2>
          <div className="flex flex-wrap gap-3">
            {(() => {
              const monthly = {}
              for (const o of orders) {
                const d = o.orderDate?.toDate ? o.orderDate.toDate() : o.orderDate ? new Date(o.orderDate) : null
                if (!d) continue
                const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
                if (!monthly[key]) monthly[key] = { count: 0, total: 0 }
                monthly[key].count++
                monthly[key].total += Number(o.total) || 0
              }
              const keys = Object.keys(monthly).sort().reverse()
              if (keys.length === 0) return <span className="text-sm text-gray-400">データなし</span>
              return keys.map((k) => (
                <div
                  key={k}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center"
                >
                  <div className="text-xs text-gray-500">{k}</div>
                  <div className="mt-1 text-lg font-bold text-gray-900">
                    {fmtYen(monthly[k].total)}
                  </div>
                  <div className="text-xs text-gray-400">{monthly[k].count}件</div>
                </div>
              ))
            })()}
          </div>
        </div>

        {/* 注文一覧テーブル */}
        <h2 className="mb-3 text-sm font-bold text-gray-700">注文履歴</h2>
        <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-3">注文番号</th>
                <th className="px-4 py-3">注文日</th>
                <th className="px-4 py-3">担当者</th>
                <th className="px-4 py-3 text-right">小計</th>
                <th className="px-4 py-3 text-right">送料</th>
                <th className="px-4 py-3 text-right">税</th>
                <th className="px-4 py-3 text-right">合計</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">{o.orderNumber}</td>
                  <td className="px-4 py-3">{fmtDate(o.orderDate)}</td>
                  <td className="px-4 py-3">{o.contact || '—'}</td>
                  <td className="px-4 py-3 text-right">{fmtYen(o.subtotal)}</td>
                  <td className="px-4 py-3 text-right">{fmtYen(o.shipping)}</td>
                  <td className="px-4 py-3 text-right">{fmtYen(o.tax)}</td>
                  <td className="px-4 py-3 text-right font-bold">{fmtYen(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // 代理店一覧
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">代理店管理</h1>
        <div className="flex gap-2">
          <button
            onClick={() => downloadKbRulesPdf()}
            className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
          >
            KB計算ルール(PDF)
          </button>
          <button
            onClick={() => downloadKbRulesXlsx()}
            className="rounded-lg border border-green-300 bg-white px-3 py-1.5 text-xs font-bold text-green-700 hover:bg-green-50"
          >
            KB計算ルール(Excel)
          </button>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        全 {dealers.length} 社 ／ 総注文数 {dealers.reduce((s, d) => s + d.count, 0)} 件 ／ 総売上 {fmtYen(dealers.reduce((s, d) => s + d.total, 0))}
      </p>

      {/* 代理店招待セクション */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-sm font-bold text-gray-700">代理店アカウントを招待</h2>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="会社名（必須）"
            value={invCompany}
            onChange={(e) => setInvCompany(e.target.value)}
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="代理店コード（例：J0002）"
            value={invCode}
            onChange={(e) => setInvCode(e.target.value)}
            className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="担当者名"
            value={invName}
            onChange={(e) => setInvName(e.target.value)}
            className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="email"
            placeholder="メールアドレス（Google）"
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDealerInvite()}
            className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <select
            value={invSubRole}
            onChange={(e) => setInvSubRole(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm focus:outline-none ${
              invSubRole ? 'border-gray-300 focus:border-indigo-500' : 'border-red-400 bg-red-50 focus:border-red-500'
            }`}
            title="招待する人の権限（必須）"
          >
            <option value="">権限を選択（必須）</option>
            <option value="admin">管理者（全権）</option>
            <option value="staff">スタッフ（閲覧のみ）</option>
          </select>
          <button
            onClick={handleDealerInvite}
            disabled={inviting}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {inviting ? '登録中...' : '📧 招待する'}
          </button>
        </div>
        {invMsg && (
          <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            {invMsg}
          </div>
        )}
        <p className="mt-3 text-xs text-gray-400">
          代理店がGoogleアカウントでログインすると、自社の注文履歴・売上のみ閲覧できます。
        </p>
      </div>

      {/* 代理店アカウント直接作成 */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-700">代理店アカウントを作成（メール＋パスワード）</h2>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-xs text-indigo-600 hover:underline"
          >
            {showCreateForm ? '閉じる' : '開く'}
          </button>
        </div>
        {showCreateForm && (
          <div className="mt-4">
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="会社名（必須）"
                value={createCompany}
                onChange={(e) => setCreateCompany(e.target.value)}
                className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="text"
                placeholder="代理店コード（例：J0002）"
                value={createCode}
                onChange={(e) => setCreateCode(e.target.value)}
                className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="text"
                placeholder="担当者名"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <select
                value={createSubRole}
                onChange={(e) => setCreateSubRole(e.target.value)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  createSubRole ? 'border-gray-300' : 'border-red-400 bg-red-50'
                }`}
                title="権限（必須）"
              >
                <option value="">権限を選択（必須）</option>
                <option value="admin">管理者（全権）</option>
                <option value="staff">スタッフ（閲覧のみ）</option>
              </select>
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              <input
                type="email"
                placeholder="メールアドレス（必須）"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="パスワード（6文字以上）"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
                />
                <button
                  onClick={generatePassword}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                >
                  自動生成
                </button>
              </div>
              <button
                onClick={handleCreateAccount}
                disabled={creating}
                className="rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {creating ? '作成中...' : 'アカウント作成'}
              </button>
            </div>
            {createMsg && (
              <div className="mt-3 whitespace-pre-line rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
                {createMsg}
              </div>
            )}
            <p className="mt-3 text-xs text-gray-400">
              Googleアカウント不要。メール＋パスワードでログインできる代理店アカウントを発行します。ログインURL：{APP_URL}/dealer-login
            </p>
          </div>
        )}
      </div>

      {/* 登録済み代理店アカウント */}
      {dealerAccounts.length > 0 && (
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 text-xs font-bold text-gray-600">
            代理店アカウント（{dealerAccounts.length}社）
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-2">代理店ID</th>
                <th className="px-4 py-2">会社名</th>
                <th className="px-4 py-2">振込先</th>
                <th className="px-4 py-2 text-center">KBグループ</th>
                <th className="px-4 py-2">メール</th>
                <th className="px-4 py-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {dealerAccounts.map((d) => (
                <tr key={d.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono font-bold text-indigo-600">{d.dealerCode}</td>
                  <td className="px-4 py-2 font-medium text-gray-900">{d.companyName}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {d.bankInfo
                      ? `${d.bankInfo.bankName} ${d.bankInfo.branchName} ${d.bankInfo.accountNumber}`
                      : <span className="text-orange-500">未設定</span>}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">{d.kbGroup || 'A'}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">{d.email}</td>
                  <td className="px-4 py-2 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => startEditDealer(d)}
                        className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-100"
                      >
                        詳細
                      </button>
                      <button
                        onClick={() => handleImpersonate(d)}
                        disabled={impersonating === d.email}
                        className="rounded bg-orange-500 px-3 py-1 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50"
                        title="代理店画面を閲覧モードで開く"
                      >
                        {impersonating === d.email ? '切替中...' : '代理店画面'}
                      </button>
                      {d.kbGroup === 'C' ? (
                        <button
                          onClick={() => navigate(`/admin/invoices?dealer=${d.dealerCode}`)}
                          className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                        >
                          請求書
                        </button>
                      ) : (
                        <button
                          onClick={() => navigate(`/admin/kickback?dealer=${d.dealerCode}`)}
                          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                        >
                          KB清算
                        </button>
                      )}
                      <button
                        onClick={() => setDeleteConfirm(d)}
                        className="rounded border border-red-300 px-3 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 代理店詳細・編集モーダル */}
      {editingDealer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">
                代理店詳細 — {editingDealer.dealerCode}
              </h2>
              <button onClick={() => setEditingDealer(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 基本情報 */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="mb-3 text-sm font-bold text-gray-700">基本情報</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-gray-500">会社名</label>
                  <input
                    type="text"
                    value={editingDealer.companyName}
                    onChange={(e) => setEditingDealer({ ...editingDealer, companyName: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">代表者</label>
                  <input
                    type="text"
                    value={editingDealer.representative}
                    onChange={(e) => setEditingDealer({ ...editingDealer, representative: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="白崎順子"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">担当者名</label>
                  <input
                    type="text"
                    value={editingDealer.name}
                    onChange={(e) => setEditingDealer({ ...editingDealer, name: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">メールアドレス（ログイン用）</label>
                  <input
                    type="email"
                    value={editingDealer.email}
                    disabled
                    className="w-full rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-500"
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-gray-500">請求書送付先メールアドレス</label>
                  <input
                    type="email"
                    value={editingDealer.invoiceEmail || ''}
                    onChange={(e) => setEditingDealer({ ...editingDealer, invoiceEmail: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="未設定の場合はログイン用メールに送信"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Bカート会員ID</label>
                  <input
                    type="text"
                    value={editingDealer.bcartId}
                    onChange={(e) => setEditingDealer({ ...editingDealer, bcartId: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
                    placeholder="10002"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">KBグループ</label>
                  <select
                    value={editingDealer.kbGroup}
                    onChange={(e) => setEditingDealer({ ...editingDealer, kbGroup: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="A">A（キックバックあり）</option>
                    <option value="B">B（キックバックあり）</option>
                    <option value="C">C（請求書発行・KBなし）</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">KB掛け率（%）</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={editingDealer.kbRate}
                      onChange={(e) => setEditingDealer({ ...editingDealer, kbRate: e.target.value === '' ? '' : Number(e.target.value) })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                      placeholder="空欄=グループ設定に従う"
                      min="0"
                      max="100"
                      step="1"
                    />
                    <span className="text-sm text-gray-500">%</span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-gray-400">空欄ならグループ設定の掛け率を使用</p>
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <input
                    type="checkbox"
                    id="includeOwnOrders"
                    checked={editingDealer.includeOwnOrders || false}
                    onChange={(e) => setEditingDealer({ ...editingDealer, includeOwnOrders: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="includeOwnOrders" className="text-xs text-gray-600">
                    自社注文をKB清算に含める（売掛）
                  </label>
                </div>
              </div>
            </div>

            {/* 連絡先 */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="mb-3 text-sm font-bold text-gray-700">連絡先</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-gray-500">住所</label>
                  <input
                    type="text"
                    value={editingDealer.address}
                    onChange={(e) => setEditingDealer({ ...editingDealer, address: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="464-0035 愛知県名古屋市千種区..."
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">電話番号</label>
                  <input
                    type="text"
                    value={editingDealer.phone}
                    onChange={(e) => setEditingDealer({ ...editingDealer, phone: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="052-734-3213"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">FAX</label>
                  <input
                    type="text"
                    value={editingDealer.fax}
                    onChange={(e) => setEditingDealer({ ...editingDealer, fax: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-gray-500">ホームページ</label>
                  <input
                    type="text"
                    value={editingDealer.website}
                    onChange={(e) => setEditingDealer({ ...editingDealer, website: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="https://"
                  />
                </div>
              </div>
            </div>

            {/* 事業情報 */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="mb-3 text-sm font-bold text-gray-700">事業情報</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">決済方法</label>
                  <input
                    type="text"
                    value={editingDealer.paymentMethod}
                    onChange={(e) => setEditingDealer({ ...editingDealer, paymentMethod: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="自社現払い"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">設立年月</label>
                  <input
                    type="text"
                    value={editingDealer.founded}
                    onChange={(e) => setEditingDealer({ ...editingDealer, founded: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="2019年6月"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">年商</label>
                  <input
                    type="text"
                    value={editingDealer.revenue}
                    onChange={(e) => setEditingDealer({ ...editingDealer, revenue: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">業種・業態</label>
                  <input
                    type="text"
                    value={editingDealer.industry}
                    onChange={(e) => setEditingDealer({ ...editingDealer, industry: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 振込先口座 */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="mb-3 text-sm font-bold text-gray-700">振込先口座情報</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">銀行名</label>
                  <input
                    type="text"
                    value={editingDealer.bankInfo.bankName}
                    onChange={(e) => setEditingDealer({
                      ...editingDealer,
                      bankInfo: { ...editingDealer.bankInfo, bankName: e.target.value },
                    })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="三井住友銀行"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">支店名</label>
                  <input
                    type="text"
                    value={editingDealer.bankInfo.branchName}
                    onChange={(e) => setEditingDealer({
                      ...editingDealer,
                      bankInfo: { ...editingDealer.bankInfo, branchName: e.target.value },
                    })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="渋谷支店"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">口座種別</label>
                  <select
                    value={editingDealer.bankInfo.accountType}
                    onChange={(e) => setEditingDealer({
                      ...editingDealer,
                      bankInfo: { ...editingDealer.bankInfo, accountType: e.target.value },
                    })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="普通">普通</option>
                    <option value="当座">当座</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">口座番号</label>
                  <input
                    type="text"
                    value={editingDealer.bankInfo.accountNumber}
                    onChange={(e) => setEditingDealer({
                      ...editingDealer,
                      bankInfo: { ...editingDealer.bankInfo, accountNumber: e.target.value },
                    })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:outline-none"
                    placeholder="1234567"
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs text-gray-500">口座名義</label>
                <input
                  type="text"
                  value={editingDealer.bankInfo.accountHolder}
                  onChange={(e) => setEditingDealer({
                    ...editingDealer,
                    bankInfo: { ...editingDealer.bankInfo, accountHolder: e.target.value },
                  })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  placeholder="カ）ピュアラボーテ"
                />
              </div>
            </div>

            {/* 毎月の固定調整項目 */}
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="mb-3 text-sm font-bold text-gray-700">毎月の固定調整項目</h3>
              <p className="mb-3 text-[10px] text-gray-400">KB清算時に毎月自動で適用される項目（業務委託費、固定費など）</p>
              {(editingDealer.fixedAdjustments || []).map((adj, idx) => (
                <div key={idx} className="mb-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={adj.label}
                    onChange={(e) => {
                      const items = [...(editingDealer.fixedAdjustments || [])]
                      items[idx] = { ...items[idx], label: e.target.value }
                      setEditingDealer({ ...editingDealer, fixedAdjustments: items })
                    }}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="項目名（例: 業務委託費）"
                  />
                  <input
                    type="number"
                    value={adj.amount}
                    onChange={(e) => {
                      const items = [...(editingDealer.fixedAdjustments || [])]
                      items[idx] = { ...items[idx], amount: Number(e.target.value) }
                      setEditingDealer({ ...editingDealer, fixedAdjustments: items })
                    }}
                    className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm text-right focus:border-indigo-500 focus:outline-none"
                    placeholder="金額"
                  />
                  <span className="text-xs text-gray-400">円</span>
                  <button
                    onClick={() => {
                      const items = (editingDealer.fixedAdjustments || []).filter((_, i) => i !== idx)
                      setEditingDealer({ ...editingDealer, fixedAdjustments: items })
                    }}
                    className="rounded border border-red-200 px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                  >✕</button>
                </div>
              ))}
              <button
                onClick={() => {
                  const items = [...(editingDealer.fixedAdjustments || []), { label: '', amount: 0 }]
                  setEditingDealer({ ...editingDealer, fixedAdjustments: items })
                }}
                className="mt-1 rounded border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
              >
                ＋ 固定項目を追加
              </button>
            </div>

            {/* メモ */}
            <div className="mb-4">
              <label className="mb-1 block text-xs font-bold text-gray-600">メモ</label>
              <textarea
                value={editingDealer.notes}
                onChange={(e) => setEditingDealer({ ...editingDealer, notes: e.target.value })}
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="社内メモ..."
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditingDealer(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={saveEditDealer}
                disabled={editSaving}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {editSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 削除確認モーダル */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg className="h-5 w-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-gray-900">アカウント削除の確認</h2>
            </div>

            <div className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-800">
              <p className="mb-2 font-bold">以下のアカウントを削除します：</p>
              <table className="w-full text-left">
                <tbody>
                  <tr><td className="py-0.5 pr-3 text-red-600">会社名</td><td className="font-medium">{deleteConfirm.companyName}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-red-600">代理店ID</td><td className="font-mono">{deleteConfirm.dealerCode}</td></tr>
                  <tr><td className="py-0.5 pr-3 text-red-600">メール</td><td>{deleteConfirm.email}</td></tr>
                </tbody>
              </table>
              <p className="mt-3 text-xs">アカウント情報がFirestoreから削除され、ログインできなくなります。この操作は取り消せません。</p>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={() => handleDeleteDealer(deleteConfirm)}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-5 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? '削除中...' : '削除する'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全会社一覧（注文データベース） */}
      <div className="overflow-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
              <th
                className="cursor-pointer px-4 py-3 hover:text-gray-900"
                onClick={() => handleSort('name')}
              >
                会社名{sortIcon('name')}
              </th>
              <th
                className="cursor-pointer px-4 py-3 text-right hover:text-gray-900"
                onClick={() => handleSort('count')}
              >
                注文数{sortIcon('count')}
              </th>
              <th
                className="cursor-pointer px-4 py-3 text-right hover:text-gray-900"
                onClick={() => handleSort('total')}
              >
                累計売上{sortIcon('total')}
              </th>
              <th
                className="cursor-pointer px-4 py-3 hover:text-gray-900"
                onClick={() => handleSort('lastOrder')}
              >
                最終注文日{sortIcon('lastOrder')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr
                key={d.name}
                onClick={() => selectDealer(d.name)}
                className="cursor-pointer border-b border-gray-50 hover:bg-indigo-50"
              >
                <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                <td className="px-4 py-3 text-right">{d.count}件</td>
                <td className="px-4 py-3 text-right font-bold text-gray-900">
                  {fmtYen(d.total)}
                </td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(d.lastOrder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
