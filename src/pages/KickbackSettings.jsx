import { useEffect, useState } from 'react'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase.js'

function parseRate(rateStr) {
  if (!rateStr) return 0
  const parts = String(rateStr).split('/')
  if (parts.length === 2) return Number(parts[0]) / Number(parts[1])
  return Number(rateStr) || 0
}

const DEFAULT_GROUP = {
  id: 'A',
  name: 'グループA（標準）',
  standardRate: '5/13',
  campaignRate: '1/3',
  systemFeePerOrder: 300,
  paymentFeeRate: 3,
  paymentFeeMethods: ['クレジット', 'Paid', '代金引換'],
  validSetNames: ['単品販売', 'ミカエル', 'エンジェル'],
  dealerRate: 40,
  salonRate1to5: 65,
  salonRate6plus: 60,
  proRate: 65,
  simplePercent: 0, // 0 = 通常計算式を使用。0以外 = 配下サロン価格の固定%
}

const ALL_PAYMENT_METHODS = [
  'クレジット',
  'Paid',
  '代金引換',
  '銀行振込',
]

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function nextGroupId(groups) {
  const usedIds = new Set(groups.map((g) => g.id))
  for (const ch of ALPHA) {
    if (!usedIds.has(ch)) return ch
  }
  return `G${Date.now()}`
}

export default function KickbackSettings() {
  const [groups, setGroups] = useState([{ ...DEFAULT_GROUP }])
  const [activeTab, setActiveTab] = useState('A')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newSetNames, setNewSetNames] = useState({})

  useEffect(() => {
    ;(async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'kickback'))
        if (snap.exists()) {
          const data = snap.data()
          if (data.groups && data.groups.length > 0) {
            // 新形式: グループ配列
            setGroups(data.groups.map((g) => ({ ...DEFAULT_GROUP, ...g })))
            setActiveTab(data.groups[0].id)
          } else {
            // 旧形式: 単一設定 → グループAとして移行
            const { updatedAt, ...rest } = data
            setGroups([{ ...DEFAULT_GROUP, ...rest, id: 'A', name: 'グループA（標準）' }])
            setActiveTab('A')
          }
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const activeGroup = groups.find((g) => g.id === activeTab) || groups[0]

  const updateGroup = (field, value) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === activeTab ? { ...g, [field]: value } : g))
    )
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await setDoc(doc(db, 'settings', 'kickback'), {
        groups,
        updatedAt: serverTimestamp(),
      })
      alert('保存しました')
    } catch (e) {
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const addGroup = () => {
    const id = nextGroupId(groups)
    const newGroup = { ...DEFAULT_GROUP, id, name: `グループ${id}` }
    setGroups([...groups, newGroup])
    setActiveTab(id)
  }

  const removeGroup = (id) => {
    if (groups.length <= 1) return
    const updated = groups.filter((g) => g.id !== id)
    setGroups(updated)
    if (activeTab === id) setActiveTab(updated[0].id)
  }

  const togglePaymentMethod = (method) => {
    const current = activeGroup.paymentFeeMethods || []
    const updated = current.includes(method)
      ? current.filter((m) => m !== method)
      : [...current, method]
    updateGroup('paymentFeeMethods', updated)
  }

  const addSetName = () => {
    const name = (newSetNames[activeTab] || '').trim()
    if (!name) return
    if ((activeGroup.validSetNames || []).includes(name)) return
    updateGroup('validSetNames', [...(activeGroup.validSetNames || []), name])
    setNewSetNames({ ...newSetNames, [activeTab]: '' })
  }

  const removeSetName = (name) => {
    updateGroup('validSetNames', (activeGroup.validSetNames || []).filter((n) => n !== name))
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">キックバック設定</h1>
      <p className="mb-6 text-sm text-gray-500">
        代理店グループごとにKB清算の計算ルールを設定します。変更は次回の計算から反映されます。
      </p>

      {/* グループタブ */}
      <div className="mb-6 flex items-center gap-1 border-b border-gray-200">
        {groups.map((g) => (
          <button
            key={g.id}
            onClick={() => setActiveTab(g.id)}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === g.id
                ? 'border-b-2 border-indigo-600 text-indigo-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {g.id}
          </button>
        ))}
        <button
          onClick={addGroup}
          className="ml-1 rounded-md px-3 py-2 text-sm font-medium text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          title="グループ追加"
        >
          + 追加
        </button>
      </div>

      {/* グループ名・削除 */}
      <div className="mb-6 flex items-center gap-3">
        <input
          type="text"
          value={activeGroup.name}
          onChange={(e) => updateGroup('name', e.target.value)}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium focus:border-indigo-500 focus:outline-none"
          placeholder="グループ名"
        />
        {groups.length > 1 && (
          <button
            onClick={() => {
              if (confirm(`「${activeGroup.name}」を削除しますか？`)) removeGroup(activeTab)
            }}
            className="rounded-lg border border-red-200 px-3 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
          >
            削除
          </button>
        )}
      </div>

      {/* 計算方式 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">計算方式</h2>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">固定KB率（配下サロン価格の%）</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={activeGroup.simplePercent || 0}
                onChange={(e) => updateGroup('simplePercent', Number(e.target.value))}
                className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <span className="text-sm text-gray-500">%</span>
            </div>
            <p className="mt-1 text-xs text-gray-400">0の場合は下記の通常計算式（KB率・キャンペーン率）を使用。0以外の場合は配下サロン売上の固定%をKB金額とします。</p>
          </div>
          {(activeGroup.simplePercent || 0) > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
              このグループは配下サロン売上 × {activeGroup.simplePercent}% の固定計算が適用されます。下記のKB率・キャンペーン率は使用されません。
            </div>
          )}
        </div>
      </div>

      {/* KB率設定 */}
      <div className={`mb-8 rounded-xl border border-gray-200 bg-white p-6 ${(activeGroup.simplePercent || 0) > 0 ? 'opacity-50' : ''}`}>
        <h2 className="mb-4 text-lg font-bold text-gray-800">KB率</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">通常KB率</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={activeGroup.standardRate}
                  onChange={(e) => updateGroup('standardRate', e.target.value)}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-sm text-gray-500">
                  ≈ {(parseRate(activeGroup.standardRate) * 100).toFixed(2)}%
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-400">定価で購入した場合のKB率</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">キャンペーンKB率</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={activeGroup.campaignRate}
                  onChange={(e) => updateGroup('campaignRate', e.target.value)}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-sm text-gray-500">
                  ≈ {(parseRate(activeGroup.campaignRate) * 100).toFixed(2)}%
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-400">キャンペーン価格（定価より安い）の場合</p>
            </div>
          </div>
          <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700">
            判定方法：同月の同商品で最も高い単価を「定価」とし、それより安い単価の注文にはキャンペーン率を適用します。
            商品名に「6+1」「キャンペーン」を含む場合もキャンペーン率が適用されます。
          </div>
        </div>
      </div>

      {/* 手数料設定 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">手数料</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">システム利用料（1件あたり）</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">¥</span>
                <input
                  type="number"
                  value={activeGroup.systemFeePerOrder}
                  onChange={(e) => updateGroup('systemFeePerOrder', Number(e.target.value))}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">決済手数料率</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={activeGroup.paymentFeeRate}
                  onChange={(e) => updateGroup('paymentFeeRate', Number(e.target.value))}
                  className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">決済手数料の対象決済方法</label>
            <div className="flex flex-wrap gap-3">
              {ALL_PAYMENT_METHODS.map((method) => (
                <label key={method} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={(activeGroup.paymentFeeMethods || []).includes(method)}
                    onChange={() => togglePaymentMethod(method)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700">{method}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-400">チェックした決済方法の注文に手数料率を適用</p>
          </div>
        </div>
      </div>

      {/* 掛け率設定 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">掛け率</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">代理店掛率</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={activeGroup.dealerRate}
                  onChange={(e) => updateGroup('dealerRate', Number(e.target.value))}
                  className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">代理店への卸売価格（定価の何%）</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">業務用掛率</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={activeGroup.proRate}
                  onChange={(e) => updateGroup('proRate', Number(e.target.value))}
                  className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">業務用化粧品のサロン掛率</p>
            </div>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">店販化粧品 サロン掛率</label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={activeGroup.salonRate1to5}
                    onChange={(e) => updateGroup('salonRate1to5', Number(e.target.value))}
                    className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                  <span className="text-sm text-gray-500">%</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">1〜5個</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={activeGroup.salonRate6plus}
                    onChange={(e) => updateGroup('salonRate6plus', Number(e.target.value))}
                    className="w-20 rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                  <span className="text-sm text-gray-500">%</span>
                </div>
                <p className="mt-1 text-xs text-gray-400">6個以上</p>
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700">
            キックバック＝サロン掛率 − 代理店掛率（例：店販5個以下 → {activeGroup.salonRate1to5 - activeGroup.dealerRate}%、6個以上 → {activeGroup.salonRate6plus - activeGroup.dealerRate}%、業務用 → {activeGroup.proRate - activeGroup.dealerRate}%）
          </div>
        </div>
      </div>

      {/* KB対象セット名 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">KB対象セット名</h2>
        <p className="mb-3 text-sm text-gray-500">以下のセット名を含む商品のみKB計算の対象になります。</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {(activeGroup.validSetNames || []).map((name) => (
            <span key={name} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-3 py-1 text-sm text-indigo-700">
              {name}
              <button onClick={() => removeSetName(name)} className="ml-1 text-indigo-400 hover:text-red-500">&times;</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newSetNames[activeTab] || ''}
            onChange={(e) => setNewSetNames({ ...newSetNames, [activeTab]: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && addSetName()}
            placeholder="セット名を入力..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={addSetName}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700"
          >
            追加
          </button>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full rounded-lg bg-indigo-600 px-6 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {saving ? '保存中...' : `設定を保存（全${groups.length}グループ）`}
      </button>
    </div>
  )
}
