import { useEffect, useState } from 'react'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

const FEATURES = [
  { key: 'orders', label: '受注発注管理', desc: '受注・発注の管理画面' },
  { key: 'inventory', label: '在庫管理', desc: '商品在庫の入出庫・編集' },
  { key: 'warehouse', label: '倉庫管理', desc: '倉庫ごとの在庫状況確認' },
  { key: 'kickback', label: 'KB清算', desc: 'キックバック清算書の管理' },
  { key: 'invoices', label: '請求書管理', desc: '請求書の作成・送付' },
  { key: 'users', label: 'スタッフ管理', desc: 'スタッフの追加・権限変更' },
  { key: 'bcartImport', label: 'Bカート取り込み', desc: 'Bカート注文データの取込' },
  { key: 'receiptPreview', label: '領収書プレビュー', desc: '領収書の確認・発行' },
  { key: 'calendar', label: 'カレンダー', desc: 'Googleカレンダーの閲覧・予定追加' },
  { key: 'salons', label: 'サロン管理', desc: 'サロン情報の閲覧・編集' },
  { key: 'dealers', label: '代理店管理', desc: '代理店情報の閲覧' },
  { key: 'chat', label: 'チャット', desc: '社内チャット機能' },
  { key: 'attendance', label: '勤怠', desc: '勤怠打刻・履歴' },
  { key: 'dealerDocs', label: '代理店資料管理', desc: '代理店向け資料のアップロード' },
  { key: 'salonManage', label: 'サロンアカウント', desc: 'サロンアカウントの招待・管理' },
  { key: 'salonSales', label: 'サロン売上検索', desc: 'サロン別・期間別の売上検索' },
  { key: 'settings', label: '設定', desc: '基本設定・KB設定・権限設定' },
]

const ROLES = [
  { key: 'master', label: 'マスター', color: 'text-red-600', alwaysOn: true },
  { key: 'admin', label: '管理者', color: 'text-indigo-600' },
  { key: 'staff', label: '社内スタッフ', color: 'text-blue-600' },
  { key: 'dealer', label: '代理店', color: 'text-emerald-600' },
  { key: 'salon', label: 'サロン', color: 'text-pink-600' },
  { key: 'client', label: '取引先', color: 'text-amber-600' },
  { key: 'warehouse', label: '倉庫', color: 'text-gray-600' },
]

// デフォルト権限
const DEFAULT_ROLE_ACCESS = {
  master: Object.fromEntries(FEATURES.map((f) => [f.key, true])),
  admin: Object.fromEntries(FEATURES.map((f) => [f.key, true])),
  staff: {
    orders: false, inventory: true, warehouse: true, kickback: false,
    invoices: false, users: false, bcartImport: false, receiptPreview: false,
    calendar: true, salons: true, dealers: true, chat: true, attendance: true,
    dealerDocs: false, salonManage: false, salonSales: false, settings: false,
  },
  dealer: {
    orders: false, inventory: false, warehouse: false, kickback: false,
    invoices: false, users: false, bcartImport: false, receiptPreview: false,
    calendar: false, salons: false, dealers: false, chat: true, attendance: false,
    dealerDocs: false, salonManage: false, salonSales: false, settings: false,
  },
  salon: {
    orders: false, inventory: false, warehouse: false, kickback: false,
    invoices: false, users: false, bcartImport: false, receiptPreview: false,
    calendar: false, salons: false, dealers: false, chat: true, attendance: false,
    dealerDocs: false, salonManage: false, salonSales: false, settings: false,
  },
  client: {
    orders: false, inventory: false, warehouse: false, kickback: false,
    invoices: false, users: false, bcartImport: false, receiptPreview: false,
    calendar: false, salons: false, dealers: false, chat: false, attendance: false,
    dealerDocs: false, salonManage: false, salonSales: false, settings: false,
  },
  warehouse: {
    orders: false, inventory: true, warehouse: true, kickback: false,
    invoices: false, users: false, bcartImport: false, receiptPreview: false,
    calendar: false, salons: false, dealers: false, chat: false, attendance: false,
    dealerDocs: false, salonManage: false, salonSales: false, settings: false,
  },
}

export default function PermissionSettings() {
  const [roleAccess, setRoleAccess] = useState(JSON.parse(JSON.stringify(DEFAULT_ROLE_ACCESS)))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'permissions'))
        if (snap.exists()) {
          const data = snap.data()
          if (data.roleAccess) {
            // 保存済みの roleAccess をマージ
            const merged = JSON.parse(JSON.stringify(DEFAULT_ROLE_ACCESS))
            for (const role of ROLES) {
              if (data.roleAccess[role.key]) {
                merged[role.key] = { ...merged[role.key], ...data.roleAccess[role.key] }
              }
            }
            setRoleAccess(merged)
          } else if (data.staffAccess) {
            // 旧形式からの移行
            const merged = JSON.parse(JSON.stringify(DEFAULT_ROLE_ACCESS))
            merged.staff = { ...merged.staff, ...data.staffAccess }
            setRoleAccess(merged)
          }
        }
      } catch (e) { console.error(e) }
      finally { setLoading(false) }
    })()
  }, [])

  const toggle = (role, feature) => {
    setRoleAccess((prev) => {
      const next = JSON.parse(JSON.stringify(prev))
      next[role][feature] = !next[role][feature]
      return next
    })
    setMsg('')
  }

  const handleSave = async () => {
    setSaving(true)
    setMsg('')
    try {
      // master は常に全ON
      const saveData = JSON.parse(JSON.stringify(roleAccess))
      saveData.master = Object.fromEntries(FEATURES.map((f) => [f.key, true]))

      // 後方互換: staffAccess も同時保存
      await setDoc(doc(db, 'settings', 'permissions'), {
        roleAccess: saveData,
        staffAccess: saveData.staff,
        updatedAt: serverTimestamp(),
      })
      setMsg('保存しました。次回ログイン時（またはページ再読み込み時）に反映されます。')
    } catch (e) { setMsg('保存失敗: ' + e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">権限設定</h1>
      <p className="mb-6 text-sm text-gray-500">
        各ロールに開放する機能を設定します。マスターは常にすべての機能を利用できます。
      </p>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">機能</th>
              {ROLES.map((r) => (
                <th key={r.key} className="px-2 py-3 text-center">
                  <span className={`text-xs font-bold ${r.color}`}>{r.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.key} className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-gray-900">{f.label}</div>
                  <div className="text-[11px] text-gray-400">{f.desc}</div>
                </td>
                {ROLES.map((r) => (
                  <td key={r.key} className="px-2 py-3 text-center">
                    {r.alwaysOn ? (
                      <div className="mx-auto h-6 w-11 rounded-full bg-indigo-600 p-0.5">
                        <div className="ml-auto h-5 w-5 rounded-full bg-white shadow" />
                      </div>
                    ) : (
                      <button
                        onClick={() => toggle(r.key, f.key)}
                        className={`mx-auto h-6 w-11 rounded-full p-0.5 transition-colors ${
                          roleAccess[r.key]?.[f.key] ? 'bg-indigo-600' : 'bg-gray-300'
                        }`}
                      >
                        <div className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
                          roleAccess[r.key]?.[f.key] ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {saving ? '保存中...' : '設定を保存'}
        </button>
        {msg && (
          <div className={`text-sm ${msg.includes('失敗') ? 'text-red-600' : 'text-green-600'}`}>{msg}</div>
        )}
      </div>
    </div>
  )
}
