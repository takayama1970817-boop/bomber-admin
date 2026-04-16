import { useEffect, useState, useRef, useCallback } from 'react'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { useCompany, CompanySwitcher } from '../contexts/CompanyContext.jsx'

// 会社別デフォルト値
const DEFAULTS = {
  rt: {
    companyName: 'ロイヤルトラスト株式会社',
    zipCode: '150-0012',
    address: '東京都渋谷区広尾5-24-3 2F',
    tel: '03-3441-7839',
    fax: '03-6332-9691',
    email: 'info@royaltrust.jp',
    taxRegistration: 'T5120001125556',
    taxRate: '10',
    taxRounding: 'floor',
    taxDisplayMode: 'exclusive',
    withholdingTax: false,
    bankName: '楽天銀行',
    bankBranch: '第二営業支店',
    bankAccountType: '普通',
    bankAccountNumber: '7358798',
    bankAccountHolder: 'ロイヤルトラスト株式会社',
    bcartDomain: '',
    bcartApiKey: '',
    bcartThreshold: 5,
    bcartMapping: 'code',
  },
  rc: {
    companyName: 'ロイヤルコスメ株式会社',
    zipCode: '150-0012',
    address: '東京都渋谷区広尾5-24-3 2F',
    tel: '03-3441-7839',
    fax: '03-6332-9691',
    email: 'info@royalcosme.jp',
    taxRegistration: '',
    taxRate: '10',
    taxRounding: 'floor',
    taxDisplayMode: 'exclusive',
    withholdingTax: false,
    bankName: '',
    bankBranch: '',
    bankAccountType: '普通',
    bankAccountNumber: '',
    bankAccountHolder: '',
    bcartDomain: '',
    bcartApiKey: '',
    bcartThreshold: 5,
    bcartMapping: 'code',
  },
}

export { DEFAULTS as COMPANY_DEFAULTS }

export default function GeneralSettings() {
  const { company: ctx } = useCompany()
  const [company, setCompany] = useState({})
  const [stampDataUrl, setStampDataUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const stampRef = useRef(null)

  // Firestoreドキュメント名: settings/rt_company, settings/rc_company
  const companyDocId = `${ctx.key}_company`
  const stampDocId = `${ctx.key}_companyStamp`
  const defaults = DEFAULTS[ctx.key] || DEFAULTS.rt

  // データ読み込み
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [companyDoc, stampDoc] = await Promise.all([
        getDoc(doc(db, 'settings', companyDocId)),
        getDoc(doc(db, 'settings', stampDocId)),
      ])
      // 旧データ（settings/company）もフォールバック
      let fallback = {}
      if (!companyDoc.exists() && ctx.key === 'rt') {
        const oldDoc = await getDoc(doc(db, 'settings', 'company'))
        if (oldDoc.exists()) fallback = oldDoc.data()
      }
      setCompany({ ...defaults, ...fallback, ...(companyDoc.exists() ? companyDoc.data() : {}) })

      // 印影
      if (stampDoc.exists() && stampDoc.data().dataUrl) {
        setStampDataUrl(stampDoc.data().dataUrl)
      } else if (ctx.key === 'rt') {
        // 旧印影フォールバック
        const oldStamp = await getDoc(doc(db, 'settings', 'companyStamp'))
        if (oldStamp.exists() && oldStamp.data().dataUrl) setStampDataUrl(oldStamp.data().dataUrl)
        else setStampDataUrl(null)
      } else {
        setStampDataUrl(null)
      }
    } finally {
      setLoading(false)
    }
  }, [companyDocId, stampDocId, ctx.key, defaults])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSaving(true)
    try {
      await setDoc(doc(db, 'settings', companyDocId), {
        ...company,
        updatedAt: serverTimestamp(),
      })
      alert('保存しました')
    } catch (e) {
      alert('保存に失敗しました: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleStampUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 500 * 1024) {
      alert('画像は500KB以下にしてください')
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result
      try {
        await setDoc(doc(db, 'settings', stampDocId), {
          dataUrl,
          updatedAt: serverTimestamp(),
        })
        setStampDataUrl(dataUrl)
        alert('印影を保存しました')
      } catch (err) {
        alert('保存に失敗しました: ' + err.message)
      }
    }
    reader.readAsDataURL(file)
  }

  const handleStampDelete = async () => {
    if (!confirm('印影を削除しますか？')) return
    try {
      await setDoc(doc(db, 'settings', stampDocId), {
        dataUrl: null,
        updatedAt: serverTimestamp(),
      })
      setStampDataUrl(null)
    } catch (e) {
      alert('削除に失敗しました: ' + e.message)
    }
  }

  if (loading) return <div className="py-20 text-center text-gray-400">読み込み中...</div>

  return (
    <div className="mx-auto max-w-2xl">
      {/* 会社切替 */}
      <div className="mb-4 w-72">
        <CompanySwitcher />
      </div>

      <h1 className="mb-2 text-2xl font-bold text-gray-900">基本設定</h1>
      <p className="mb-8 text-sm text-gray-500">
        <span className={`font-bold ${ctx.text}`}>{ctx.name}</span> の会社情報・印影・税設定を管理します
      </p>

      {/* 会社情報 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">会社情報</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">会社名</label>
            <input type="text" value={company.companyName || ''}
              onChange={(e) => setCompany({ ...company, companyName: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">郵便番号</label>
              <input type="text" value={company.zipCode || ''}
                onChange={(e) => setCompany({ ...company, zipCode: e.target.value })}
                placeholder="150-0012"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">電話番号</label>
              <input type="text" value={company.tel || ''}
                onChange={(e) => setCompany({ ...company, tel: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">FAX</label>
              <input type="text" value={company.fax || ''}
                onChange={(e) => setCompany({ ...company, fax: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">メールアドレス</label>
              <input type="text" value={company.email || ''}
                onChange={(e) => setCompany({ ...company, email: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">住所</label>
            <input type="text" value={company.address || ''}
              onChange={(e) => setCompany({ ...company, address: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">適格請求書発行事業者登録番号</label>
            <input type="text" value={company.taxRegistration || ''}
              onChange={(e) => setCompany({ ...company, taxRegistration: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
        </div>
      </div>

      {/* 課税設定 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">課税設定</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">課税表示方式</label>
            <select value={company.taxDisplayMode || 'exclusive'}
              onChange={(e) => setCompany({ ...company, taxDisplayMode: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none">
              <option value="exclusive">税別表示</option>
              <option value="inclusive">税込表示</option>
              <option value="exempt">免税</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">消費税率</label>
              <select value={company.taxRate || '10'}
                onChange={(e) => setCompany({ ...company, taxRate: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                <option value="10">10%</option>
                <option value="8r">軽減8%</option>
                <option value="8">8%</option>
                <option value="5">5%</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">消費税端数処理</label>
              <select value={company.taxRounding || 'floor'}
                onChange={(e) => setCompany({ ...company, taxRounding: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                <option value="floor">切り捨て</option>
                <option value="ceil">切り上げ</option>
                <option value="round">四捨五入</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 振込先情報 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">振込先情報</h2>
        <p className="mb-4 text-sm text-gray-500">請求書に表示される振込先口座情報です。</p>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">銀行名</label>
              <input type="text" value={company.bankName || ''}
                onChange={(e) => setCompany({ ...company, bankName: e.target.value })}
                placeholder="例: 楽天銀行"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">支店名</label>
              <input type="text" value={company.bankBranch || ''}
                onChange={(e) => setCompany({ ...company, bankBranch: e.target.value })}
                placeholder="例: 第二営業支店"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">口座種別</label>
              <select value={company.bankAccountType || '普通'}
                onChange={(e) => setCompany({ ...company, bankAccountType: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none">
                <option value="普通">普通</option>
                <option value="当座">当座</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">口座番号</label>
              <input type="text" value={company.bankAccountNumber || ''}
                onChange={(e) => setCompany({ ...company, bankAccountNumber: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">口座名義</label>
              <input type="text" value={company.bankAccountHolder || ''}
                onChange={(e) => setCompany({ ...company, bankAccountHolder: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
        </div>
      </div>

      {/* メール送信設定（AWS SES） */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">メール送信設定</h2>
        <p className="mb-4 text-sm text-gray-500">
          帳票をメール送信するためのAWS SES設定です。未設定の場合メール送信は使えません。
        </p>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">SESリージョン</label>
            <select value={company.sesRegion || 'ap-northeast-1'}
              onChange={(e) => setCompany({ ...company, sesRegion: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none">
              <option value="ap-northeast-1">東京 (ap-northeast-1)</option>
              <option value="us-east-1">バージニア (us-east-1)</option>
              <option value="eu-west-1">アイルランド (eu-west-1)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">アクセスキーID</label>
              <input type="password" value={company.sesAccessKeyId || ''}
                onChange={(e) => setCompany({ ...company, sesAccessKeyId: e.target.value })}
                placeholder="AKIA..."
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">シークレットアクセスキー</label>
              <input type="password" value={company.sesSecretAccessKey || ''}
                onChange={(e) => setCompany({ ...company, sesSecretAccessKey: e.target.value })}
                placeholder="シークレットキー"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            ※ AWS SESで送信元メールアドレス（{company.email || '未設定'}）の認証が必要です
          </p>
        </div>
      </div>

      {/* 保存ボタン */}
      <div className="mb-8">
        <button onClick={handleSave} disabled={saving}
          className={`rounded-lg px-6 py-2.5 text-sm font-bold text-white disabled:opacity-50 ${ctx.bg} hover:opacity-90`}>
          {saving ? '保存中...' : `${ctx.name}の設定を保存`}
        </button>
      </div>

      {/* 印影設定 */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">会社印影</h2>
        <p className="mb-4 text-sm text-gray-500">
          帳票に表示される会社の印影画像を設定します。PNG/JPG形式、500KB以下。
        </p>
        {stampDataUrl ? (
          <div className="flex items-center gap-6">
            <div className="flex h-28 w-28 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 p-2">
              <img src={stampDataUrl} alt="印影" className="max-h-full max-w-full object-contain" />
            </div>
            <div className="space-y-2">
              <button onClick={() => stampRef.current?.click()}
                className="block rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                画像を変更
              </button>
              <button onClick={handleStampDelete}
                className="block rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                削除
              </button>
            </div>
          </div>
        ) : (
          <div onClick={() => stampRef.current?.click()}
            className="flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 hover:border-indigo-400 hover:bg-indigo-50">
            <svg className="mb-2 h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <span className="text-sm text-gray-500">クリックして印影画像をアップロード</span>
            <span className="mt-1 text-xs text-gray-400">PNG / JPG（500KB以下）</span>
          </div>
        )}
        <input ref={stampRef} type="file" accept="image/*" className="hidden" onChange={handleStampUpload} />
      </div>

      {/* プレビュー */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-bold text-gray-800">帳票プレビュー</h2>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-start justify-between">
            <div className="text-sm text-gray-700 leading-relaxed">
              <div className="font-bold">{company.companyName}</div>
              <div>〒{company.zipCode} {company.address}</div>
              <div>TEL: {company.tel}{company.fax ? `　FAX: ${company.fax}` : ''}</div>
              {company.email && <div>email: {company.email}</div>}
              {company.taxRegistration && <div>登録番号: {company.taxRegistration}</div>}
              {company.bankName && (
                <div className="mt-2 border-t border-gray-200 pt-2">
                  <div className="text-xs text-gray-500">振込先: {company.bankName} {company.bankBranch} {company.bankAccountType} {company.bankAccountNumber}</div>
                  <div className="text-xs text-gray-500">名義: {company.bankAccountHolder}</div>
                </div>
              )}
            </div>
            {stampDataUrl && (
              <img src={stampDataUrl} alt="印影" className="ml-4 h-16 w-16 object-contain opacity-85" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
