import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  collection, doc, getDocs, addDoc, getDoc,
  orderBy, query, serverTimestamp, updateDoc, deleteDoc,
  runTransaction,
} from 'firebase/firestore'
import { db, functions } from '../lib/firebase.js'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useCompany, CompanySwitcher } from '../contexts/CompanyContext.jsx'
import { calcTax } from '../lib/taxCalc.js'
import { openProjectDocPreview, buildProjectDocHtml, downloadProjectDocPdf, buildProjectDocPdfBase64, DOC_TYPES } from '../lib/generateProjectDoc.js'
import { downloadEml } from '../lib/generateEml.js'

// ── ステータス定義 ──
const STATUSES = [
  { key: 'quote',     label: '見積',     icon: '📝', bg: 'bg-gray-100',    text: 'text-gray-700' },
  { key: 'accepted',  label: '注文請負', icon: '🤝', bg: 'bg-blue-100',    text: 'text-blue-700' },
  { key: 'ordered',   label: '工場発注', icon: '📋', bg: 'bg-orange-100',  text: 'text-orange-700' },
  { key: 'producing', label: '製造中',   icon: '🏭', bg: 'bg-yellow-100',  text: 'text-yellow-700' },
  { key: 'delivered', label: '納品済',   icon: '🚚', bg: 'bg-indigo-100',  text: 'text-indigo-700' },
  { key: 'invoiced',  label: '請求済',   icon: '📄', bg: 'bg-purple-100',  text: 'text-purple-700' },
  { key: 'awaiting',  label: '入金待ち', icon: '💰', bg: 'bg-pink-100',    text: 'text-pink-700' },
  { key: 'completed', label: '完了',     icon: '✅', bg: 'bg-green-100',   text: 'text-green-700' },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]))

const fmtDate = (t) => {
  if (!t) return '—'
  const d = t.toDate ? t.toDate() : new Date(t)
  return d.toLocaleDateString('ja-JP')
}

const fmtYen = (n) => `¥${(n ?? 0).toLocaleString('ja-JP')}`

// ── 案件番号自動生成 ──
function generateProjectNo(prefix, existingNos) {
  const now = new Date()
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const base = `${prefix}-${dateStr}`
  const matching = existingNos.filter((n) => n.startsWith(base))
  return `${base}-${String(matching.length + 1).padStart(3, '0')}`
}

// ── 帳票タイプ日本語ラベル＋番号プレフィックス ──
const DOC_LABELS = {
  quote: '見積書', acceptance: '注文請負書', purchase: '発注書',
  delivery: '納品書', invoice: '請求書', receipt: '領収書',
}
const DOC_PREFIX = {
  quote: 'Q', acceptance: 'A', purchase: 'PO',
  delivery: 'D', invoice: 'INV', receipt: 'R',
}

// ── メール送信モーダル ──
function SendEmailModal({ isOpen, onClose, project, docType, companyInfo, taxSettings, stampDataUrl, companyKey, onSent }) {
  const label = DOC_LABELS[docType] || '帳票'

  // 発注書 → 仕入れ先メール、それ以外 → 取引先メール
  const isToFactory = docType === 'purchase'

  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (isOpen && project) {
      setTo(isToFactory ? (project.factoryEmail || '') : (project.clientEmail || ''))
      setCc('takayama1970817@gmail.com')
    }
  }, [isOpen, project, isToFactory])

  // isTest=true のときは to を差し替え、件名に【テスト】、本文冒頭にテスト表記を入れる
  const handleSend = async (isTest = false) => {
    const actualTo = isTest ? 'takayama1970817@gmail.com' : to.trim()
    if (!actualTo) { alert('宛先メールアドレスを入力してください'); return }
    setSending(true)
    try {
      // 帳票番号
      const docNo = project[`docNo_${docType}`] || project.projectNo

      // PDF生成
      const { base64, fileName } = await buildProjectDocPdfBase64({
        docType, project, company: companyInfo, taxSettings, stampDataUrl,
        docNo, date: new Date(),
      })

      // メール件名・本文
      const companyName = companyInfo?.companyName || companyInfo?.name || 'ロイヤルトラスト株式会社'
      const senderEmail = companyInfo?.email || 'inv@royaltrust.jp'
      const partnerName = isToFactory
        ? (project.factoryName || '仕入れ先')
        : (project.clientName || '取引先')
      const personName = isToFactory
        ? (project.factoryPerson || '')
        : (project.clientPerson || '')

      const total = project.total ?? project.subtotal
      const yen = total != null ? '¥' + Number(total).toLocaleString() : ''

      const subject = (isTest ? '【テスト】' : '') + `【${companyName}】${label}ご送付（${docNo}）`

      const greeting = isToFactory
        ? `${partnerName}${personName ? ` ${personName}様` : ' 御中'}`
        : `${partnerName}${personName ? ` ${personName}様` : ' 御中'}`

      const bodyMain = (() => {
        if (docType === 'quote') {
          return `下記の件、お見積書をお送りいたします。\nご査収のほどよろしくお願い申し上げます。`
        }
        if (docType === 'acceptance') {
          return `下記の件、注文請負書をお送りいたします。\nご確認のほどよろしくお願い申し上げます。`
        }
        if (docType === 'purchase') {
          return `下記の件、発注書をお送りいたします。\n何卒よろしくお願い申し上げます。`
        }
        if (docType === 'delivery') {
          return `下記の件、納品書をお送りいたします。\nご検収のほどよろしくお願い申し上げます。`
        }
        if (docType === 'invoice') {
          return `下記の件、請求書をお送りいたします。\nお支払いのほどよろしくお願い申し上げます。`
        }
        if (docType === 'receipt') {
          return `下記の件、領収書をお送りいたします。\nご査収のほどよろしくお願い申し上げます。`
        }
        return `${label}をお送りいたします。\nご確認のほどよろしくお願い申し上げます。`
      })()

      const testNote = isTest ? `※これはテスト送信です。本番宛先: ${to.trim() || '（未入力）'}\n\n` : ''
      const body = testNote +
`${greeting}

いつもお世話になっております。
${companyName}です。

${bodyMain}

■ 案件番号： ${project.projectNo || '—'}
■ 件名： ${project.subject || '—'}
■ ${label}番号： ${docNo}${yen ? `\n■ 金額： ${yen}（税込）` : ''}
■ 添付ファイル： ${fileName}

ご不明点がございましたら、本メールへご返信ください。

--
${companyName}
${senderEmail}
`

      // .eml ダウンロード
      const monthTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      downloadEml({
        from: `${companyName} <${senderEmail}>`,
        to: actualTo,
        cc: isTest ? undefined : (cc.trim() || undefined),
        subject,
        body,
        pdfBase64: base64,
        pdfFileName: fileName,
        emlFileName: `${isTest ? 'TEST_' : ''}${label}_${docNo}_${monthTag}.eml`,
      })

      if (!isTest) {
        await onSent(docType)
      }
      alert(
        (isTest ? `テスト用Gmail作成画面を開きました（宛先: ${actualTo}）\n\n` : `Gmail作成画面を新しいタブで開きました。\n\n`) +
        `【手順】\n` +
        `1. ダウンロードフォルダのPDFを Gmail 作成画面にドラッグ＆ドロップ\n` +
        `2. 内容を確認して「送信」ボタンを押す\n\n` +
        `※ ポップアップがブロックされた場合は、アドレスバー右のアイコンから許可してください。`
      )
      if (!isTest) onClose()
    } catch (e) {
      console.error('メール下書き生成エラー:', e)
      alert('メール下書きの生成に失敗しました: ' + (e.message || ''))
    } finally {
      setSending(false)
    }
  }

  if (!isOpen || !project) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6">
        <h3 className="mb-4 text-lg font-bold text-gray-900">📧 {label}のメール下書きを作成</h3>
        <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
          PDFがダウンロードされ、Gmail作成画面が新しいタブで開きます（宛先・件名・本文すべて入力済み）。
          PDFを Gmail 画面にドラッグ＆ドロップして「送信」を押してください。
        </p>
        <div className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div>案件: {project.projectNo}</div>
          <div>送信先: {isToFactory ? `🏭 ${project.factoryName || '仕入れ先'}` : `🏢 ${project.clientName || '取引先'}`}</div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">宛先 *</label>
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)}
              placeholder="example@company.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">CC（自社確認用）</label>
            <input type="email" value={cc} onChange={(e) => setCc(e.target.value)}
              placeholder="info@royaltrust.jp"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={onClose}
            className="flex-1 min-w-[80px] rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">
            キャンセル
          </button>
          <button onClick={() => handleSend(true)} disabled={sending}
            className="flex-1 min-w-[120px] rounded-lg border border-green-400 bg-green-50 py-2.5 text-sm font-bold text-green-700 hover:bg-green-100 disabled:opacity-50"
            title="takayama1970817@gmail.com 宛にテスト下書きを作成">
            {sending ? '生成中...' : '🧪 テスト'}
          </button>
          <button onClick={() => handleSend(false)} disabled={sending}
            className="flex-1 min-w-[140px] rounded-lg bg-blue-600 py-2.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">
            {sending ? '生成中...' : '📧 Gmail下書き'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 新規案件モーダル ──
function CreateProjectModal({ isOpen, onClose, onSave, company, bpClients, bpProducts, bpSuppliers, bpDestinations }) {
  const [form, setForm] = useState({
    clientName: '',
    clientPerson: '',
    clientAddress: '',
    clientEmail: '',
    factoryName: '',
    factoryPerson: '',
    factoryEmail: '',
    destName: '',
    destPerson: '',
    destAddress: '',
    destTel: '',
    subject: '',
    deliveryDate: '',
    notes: '',
    items: [{ name: '', code: '', qty: '', unitPrice: '' }],
  })
  const [saving, setSaving] = useState(false)

  const handleItemChange = (idx, field, value) => {
    setForm((prev) => {
      const items = [...prev.items]
      items[idx] = { ...items[idx], [field]: value }
      return { ...prev, items }
    })
  }

  const addItem = () => {
    setForm((prev) => ({
      ...prev,
      items: [...prev.items, { name: '', code: '', qty: '', unitPrice: '' }],
    }))
  }

  const removeItem = (idx) => {
    setForm((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }))
  }

  const items = form.items.map((it) => ({
    ...it,
    amount: (parseFloat(it.qty) || 0) * (parseFloat(it.unitPrice) || 0),
  }))
  const subtotal = items.reduce((s, it) => s + it.amount, 0)

  const handleSave = async () => {
    if (!form.clientName.trim() && !form.factoryName.trim()) { alert('取引先名または発注先工場を入力してください'); return }
    if (items.some((it) => !it.name)) { alert('品名を入力してください'); return }
    setSaving(true)
    try {
      await onSave({ ...form, items, subtotal })
      setForm({
        clientName: '', clientPerson: '', clientAddress: '', clientEmail: '',
        factoryName: '', factoryPerson: '', factoryEmail: '',
        destName: '', destPerson: '', destAddress: '', destTel: '',
        subject: '', deliveryDate: '', notes: '',
        items: [{ name: '', code: '', qty: '', unitPrice: '' }],
      })
      onClose()
    } catch (e) {
      console.error('保存エラー:', e)
      alert('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6">
        <h2 className="mb-4 text-xl font-bold text-gray-900">新規案件作成</h2>

        {/* 取引先 */}
        <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">取引先（納品先）</h3>
          {bpClients.length > 0 && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600">BPマスタから選択</label>
              <select
                value=""
                onChange={(e) => {
                  const c = bpClients.find((x) => x.id === e.target.value)
                  if (c) setForm({ ...form, clientName: c.name, clientPerson: c.person || '', clientAddress: (c.zipCode ? c.zipCode + ' ' : '') + (c.address || ''), clientEmail: c.email || '', clientTel: c.tel || '' })
                }}
                className="mt-1 w-full rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-700 focus:border-indigo-500 focus:outline-none">
                <option value="">-- 取引先を選択 --</option>
                {bpClients.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">取引先名</label>
              <input type="text" value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
                placeholder="例: 〇〇株式会社"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">担当者名</label>
              <input type="text" value={form.clientPerson}
                onChange={(e) => setForm({ ...form, clientPerson: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-gray-600">住所</label>
              <input type="text" value={form.clientAddress}
                onChange={(e) => setForm({ ...form, clientAddress: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
        </div>

        {/* 工場・納期 */}
        <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">製造・納期</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-600">発注先工場</label>
              {bpSuppliers.length > 0 ? (
                <select
                  value=""
                  onChange={(e) => {
                    const s = bpSuppliers.find((x) => x.id === e.target.value)
                    if (s) setForm({ ...form, factoryName: s.name, factoryPerson: s.person || '', factoryEmail: s.email || '' })
                  }}
                  className="mt-1 w-full rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-700 focus:border-orange-500 focus:outline-none">
                  <option value="">{form.factoryName || '-- 仕入れ先を選択 --'}</option>
                  {bpSuppliers.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
                </select>
              ) : (
                <input type="text" value={form.factoryName}
                  onChange={(e) => setForm({ ...form, factoryName: e.target.value })}
                  placeholder="例: ABC工場"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">件名</label>
              <input type="text" value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="例: OEMクリーム製造"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">納期</label>
              <input type="date" value={form.deliveryDate}
                onChange={(e) => setForm({ ...form, deliveryDate: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
        </div>

        {/* 納品先 */}
        <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">📍 納品先</h3>
          {bpDestinations.length > 0 && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600">BPマスタから選択</label>
              <select
                value=""
                onChange={(e) => {
                  const d = bpDestinations.find((x) => x.id === e.target.value)
                  if (d) setForm({ ...form, destName: d.name, destPerson: d.person || '', destAddress: (d.zipCode ? '〒' + d.zipCode + ' ' : '') + (d.address || ''), destTel: d.tel || '' })
                }}
                className="mt-1 w-full rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-sm text-teal-700 focus:border-teal-500 focus:outline-none">
                <option value="">-- 納品先を選択 --</option>
                {bpDestinations.map((d) => <option key={d.id} value={d.id}>{d.code} — {d.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">納品先名</label>
              <input type="text" value={form.destName}
                onChange={(e) => setForm({ ...form, destName: e.target.value })}
                placeholder="例: 〇〇倉庫"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">担当者</label>
              <input type="text" value={form.destPerson}
                onChange={(e) => setForm({ ...form, destPerson: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">住所</label>
              <input type="text" value={form.destAddress}
                onChange={(e) => setForm({ ...form, destAddress: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">TEL</label>
              <input type="text" value={form.destTel}
                onChange={(e) => setForm({ ...form, destTel: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          </div>
        </div>

        {/* 明細 */}
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">明細</h3>
            <div className="flex gap-2">
              {bpProducts.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const p = bpProducts.find((x) => x.id === e.target.value)
                    if (p) {
                      setForm((prev) => ({
                        ...prev,
                        items: [...prev.items, { name: p.name, code: p.code || '', qty: '1', unitPrice: String(p.sellingPrice || 0), costPrice: String(p.costPrice || 0) }],
                      }))
                    }
                  }}
                  className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1 text-xs text-indigo-700">
                  <option value="">+ 商品マスタから追加</option>
                  {bpProducts.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name} ({p.sellingPrice?.toLocaleString()}円)</option>)}
                </select>
              )}
              <button onClick={addItem}
                className="rounded-lg bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300">
                + 手入力追加
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">品名</th>
                  <th className="px-3 py-2">品番</th>
                  <th className="px-3 py-2 text-right">数量</th>
                  <th className="px-3 py-2 text-right">単価</th>
                  <th className="px-3 py-2 text-right">金額</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-t border-gray-200">
                    <td className="px-2 py-1.5">
                      <input type="text" value={form.items[idx].name}
                        onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input type="text" value={form.items[idx].code}
                        onChange={(e) => handleItemChange(idx, 'code', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1" />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input type="number" value={form.items[idx].qty}
                        onChange={(e) => handleItemChange(idx, 'qty', e.target.value)}
                        className="w-20 rounded border border-gray-300 px-2 py-1 text-right" />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input type="number" value={form.items[idx].unitPrice}
                        onChange={(e) => handleItemChange(idx, 'unitPrice', e.target.value)}
                        className="w-24 rounded border border-gray-300 px-2 py-1 text-right" />
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{fmtYen(it.amount)}</td>
                    <td className="px-2 py-1.5">
                      {form.items.length > 1 && (
                        <button onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600">✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50">
                  <td colSpan={4} className="px-3 py-2 text-right font-bold">小計</td>
                  <td className="px-3 py-2 text-right font-bold">{fmtYen(subtotal)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* 備考 */}
        <div className="mb-5">
          <label className="block text-xs font-medium text-gray-600">備考</label>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={2} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
        </div>

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm text-gray-600 hover:bg-gray-50">
            キャンセル
          </button>
          <button onClick={handleSave} disabled={saving}
            className={`flex-1 rounded-lg py-2.5 text-sm font-bold text-white disabled:opacity-50 ${company.bg} hover:opacity-90`}>
            {saving ? '保存中...' : '案件を作成'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── メイン ──
export default function ProjectManage() {
  const { isAdmin } = useAuth()
  const { company } = useCompany()

  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [filterStatus, setFilterStatus] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [updatingId, setUpdatingId] = useState(null)
  const [emailModal, setEmailModal] = useState({ open: false, project: null, docType: null })
  const [faxModal, setFaxModal] = useState({ open: false, project: null, docType: null })
  const [faxNumber, setFaxNumber] = useState('')
  const [faxSending, setFaxSending] = useState(false)

  const [taxSettings, setTaxSettings] = useState({})
  const [companyInfo, setCompanyInfo] = useState({})

  const [stampDataUrl, setStampDataUrl] = useState('')

  // BPマスタデータ
  const [bpClients, setBpClients] = useState([])
  const [bpProducts, setBpProducts] = useState([])
  const [bpSuppliers, setBpSuppliers] = useState([])
  const [bpDestinations, setBpDestinations] = useState([])

  // ── データ読み込み ──
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const ck = company.key // rt or rc
      const [snap, compDoc, stampDoc, clientsSnap, productsSnap, suppliersSnap, destSnap] = await Promise.all([
        getDocs(query(collection(db, company.collection), orderBy('createdAt', 'desc'))),
        getDoc(doc(db, 'settings', `${ck}_company`)),
        getDoc(doc(db, 'settings', `${ck}_companyStamp`)),
        getDocs(collection(db, `${ck}_bp_clients`)),
        getDocs(collection(db, `${ck}_bp_products`)),
        getDocs(collection(db, `${ck}_bp_suppliers`)),
        getDocs(collection(db, `${ck}_bp_destinations`)),
      ])
      setProjects(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setBpClients(clientsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setBpProducts(productsSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setBpSuppliers(suppliersSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      setBpDestinations(destSnap.docs.map((d) => ({ id: d.id, ...d.data() })))
      if (stampDoc.exists()) setStampDataUrl(stampDoc.data().dataUrl || '')
      // 会社情報: デフォルト値をベースにFirestoreの値で上書き
      const defaultsMap = {
        rt: { companyName: 'ロイヤルトラスト株式会社', zipCode: '150-0012', address: '東京都渋谷区広尾5-24-3 2F', tel: '03-3441-7839', fax: '03-6332-9691', email: 'info@royaltrust.jp', taxRegistration: 'T5120001125556' },
        rc: { companyName: 'ロイヤルコスメ株式会社', zipCode: '150-0012', address: '東京都渋谷区広尾5-24-3 2F', tel: '03-3441-7839', fax: '03-6332-9691', email: 'info@royalcosme.jp', taxRegistration: '' },
      }
      const defaultCompany = { ...defaultsMap[company.key] || defaultsMap.rt, taxRate: '10', taxRounding: 'floor', taxDisplayMode: 'exclusive' }
      const data = compDoc.exists() ? { ...defaultCompany, ...compDoc.data() } : defaultCompany
      setCompanyInfo(data)
      setTaxSettings({ taxRate: data.taxRate || '10', taxRounding: data.taxRounding || 'floor', taxDisplayMode: data.taxDisplayMode || 'exclusive' })
    } catch (e) {
      console.error('案件読み込みエラー:', e)
    } finally {
      setLoading(false)
    }
  }, [company.collection])

  useEffect(() => { load() }, [load])

  // ── フィルタ・検索 ──
  const filtered = useMemo(() => {
    let list = projects
    if (filterStatus !== 'all') list = list.filter((p) => (p.status || 'quote') === filterStatus)
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter((p) =>
        (p.clientName || '').toLowerCase().includes(q) ||
        (p.projectNo || '').toLowerCase().includes(q) ||
        (p.subject || '').toLowerCase().includes(q) ||
        (p.factoryName || '').toLowerCase().includes(q) ||
        (p.docNo_quote || '').toLowerCase().includes(q) ||
        (p.docNo_acceptance || '').toLowerCase().includes(q) ||
        (p.docNo_purchase || '').toLowerCase().includes(q) ||
        (p.docNo_delivery || '').toLowerCase().includes(q) ||
        (p.docNo_invoice || '').toLowerCase().includes(q) ||
        (p.docNo_receipt || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [projects, filterStatus, searchText])

  // ── 集計 ──
  const statusCounts = useMemo(() => {
    const counts = { all: projects.length }
    STATUSES.forEach((s) => { counts[s.key] = projects.filter((p) => (p.status || 'quote') === s.key).length })
    return counts
  }, [projects])

  const activeTotal = useMemo(() => {
    return projects.filter((p) => !['completed'].includes(p.status)).reduce((s, p) => s + (p.subtotal || 0), 0)
  }, [projects])

  // ── 新規作成 ──
  const handleCreate = async (formData) => {
    const existingNos = projects.map((p) => p.projectNo || '').filter(Boolean)
    const prefix = company.key === 'rc' ? 'RC' : 'RT'
    const projectNo = generateProjectNo(prefix, existingNos)
    const tax = calcTax(formData.subtotal || 0, taxSettings)

    const data = {
      projectNo,
      company: company.key,
      status: 'quote',
      clientName: formData.clientName,
      clientPerson: formData.clientPerson || '',
      clientAddress: formData.clientAddress || '',
      clientEmail: formData.clientEmail || '',
      factoryName: formData.factoryName || '',
      factoryPerson: formData.factoryPerson || '',
      factoryEmail: formData.factoryEmail || '',
      destName: formData.destName || '',
      destPerson: formData.destPerson || '',
      destAddress: formData.destAddress || '',
      destTel: formData.destTel || '',
      subject: formData.subject || '',
      deliveryDate: formData.deliveryDate || '',
      notes: formData.notes || '',
      items: formData.items,
      subtotal: formData.subtotal || 0,
      tax,
      total: (formData.subtotal || 0) + tax,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }

    const ref = await addDoc(collection(db, company.collection), data)
    setProjects((prev) => [{ id: ref.id, ...data, createdAt: new Date() }, ...prev])
  }

  // ── ステータス変更（任意のステータスにジャンプ可能） ──
  const changeStatus = async (project, newStatus) => {
    if ((project.status || 'quote') === newStatus) return
    setUpdatingId(project.id)
    try {
      await updateDoc(doc(db, company.collection, project.id), {
        status: newStatus,
        [`${newStatus}At`]: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setProjects((prev) => prev.map((p) => p.id === project.id ? { ...p, status: newStatus } : p))
    } catch (e) {
      alert('更新に失敗しました')
    } finally {
      setUpdatingId(null)
    }
  }

  // ── 帳票番号の自動採番 ──
  const assignDocNo = async (docType, project) => {
    const key = `docNo_${docType}`
    // 既に採番済みならそのまま返す
    if (project[key]) return project[key]

    // Firestoreトランザクションでカウンター更新
    const now = new Date()
    const ym = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`
    const prefix = DOC_PREFIX[docType] || 'DOC'
    const counterDocId = `${company.key}_docCounters`
    const counterKey = `${docType}_${ym}`

    const newNo = await runTransaction(db, async (tx) => {
      const counterRef = doc(db, 'settings', counterDocId)
      const counterDoc = await tx.get(counterRef)
      const counters = counterDoc.exists() ? counterDoc.data() : {}
      const seq = (counters[counterKey] || 0) + 1
      tx.set(counterRef, { ...counters, [counterKey]: seq }, { merge: true })
      return `${prefix}${ym}-${String(seq).padStart(3, '0')}`
    })

    // プロジェクトに帳票番号を保存
    await updateDoc(doc(db, company.collection, project.id), {
      [key]: newNo,
      updatedAt: serverTimestamp(),
    })
    setProjects((prev) => prev.map((p) => p.id === project.id ? { ...p, [key]: newNo } : p))

    return newNo
  }

  // ── 帳票共通: openProjectDocPreview に渡すオプションを組み立て ──
  const printDoc = async (docType, project) => {
    const docNo = await assignDocNo(docType, project)
    let printProject = project

    // 発注書は原価ベースで算出
    if (docType === 'purchase') {
      const costItems = (project.items || []).map((it) => {
        const cost = parseFloat(it.costPrice) || parseFloat(it.unitPrice) || 0
        const qty = it.qty || it.quantity || 0
        return { ...it, unitPrice: cost, amount: cost * qty }
      })
      const costSubtotal = costItems.reduce((s, it) => s + (it.amount || 0), 0)
      const costTax = calcTax(costSubtotal, taxSettings)
      printProject = {
        ...project,
        items: costItems,
        subtotal: costSubtotal,
        tax: costTax,
        total: costSubtotal + costTax,
      }
    }

    openProjectDocPreview({
      docType,
      project: printProject,
      company: companyInfo,
      taxSettings,
      stampDataUrl,
      docNo,
      date: new Date(),
    })
  }

  // ── FAX送信モーダルを開く ──
  const openFaxModal = (docType, project) => {
    const isToFactory = docType === 'purchase'
    const defaultFax = isToFactory ? (project.factoryFax || '') : (project.clientFax || '')
    setFaxNumber(defaultFax)
    setFaxModal({ open: true, project, docType })
  }

  // ── FAX送信実行 ──
  const sendFaxForDoc = async () => {
    if (!faxNumber.trim()) { alert('FAX番号を入力してください'); return }
    const { project, docType } = faxModal
    if (!project || !docType) return
    setFaxSending(true)
    try {
      const docNo = await assignDocNo(docType, project)
      let printProject = project
      if (docType === 'purchase') printProject = getPurchaseProject(project)

      const { base64, fileName } = await buildProjectDocPdfBase64({
        docType,
        project: printProject,
        company: companyInfo,
        taxSettings,
        stampDataUrl,
        docNo,
        date: new Date(),
      })

      const fn = httpsCallable(functions, 'sendFax')
      const res = await fn({
        pdfBase64: base64,
        fileName,
        toNumber: faxNumber.trim(),
        projectId: project.id,
        docType,
        companyKey: company.key,
      })

      // 送信済みマーク
      const faxKey = `faxSent_${docType}`
      await updateDoc(doc(db, company.collection, project.id), {
        [faxKey]: new Date().toISOString(),
        [`faxTo_${docType}`]: faxNumber.trim(),
        updatedAt: serverTimestamp(),
      })
      setProjects((prev) => prev.map((p) =>
        p.id === project.id ? { ...p, [faxKey]: new Date().toISOString(), [`faxTo_${docType}`]: faxNumber.trim() } : p
      ))

      alert(`FAX送信を受付けました。\n状態: ${res.data.status || 'queued'}\nFAX ID: ${res.data.faxId || '-'}`)
      setFaxModal({ open: false, project: null, docType: null })
      setFaxNumber('')
    } catch (e) {
      console.error('FAX送信エラー:', e)
      alert('FAX送信に失敗しました: ' + (e?.message || e?.code || ''))
    } finally {
      setFaxSending(false)
    }
  }

  // ── 帳票PDFダウンロード ──
  const downloadDocPdf = async (docType, project) => {
    try {
      const docNo = await assignDocNo(docType, project)
      let printProject = project
      if (docType === 'purchase') {
        printProject = getPurchaseProject(project)
      }
      await downloadProjectDocPdf({
        docType,
        project: printProject,
        company: companyInfo,
        taxSettings,
        stampDataUrl,
        docNo,
        date: new Date(),
      })
    } catch (e) {
      console.error('PDF生成エラー:', e)
      alert('PDF生成に失敗しました: ' + (e?.message || e))
    }
  }

  // ── メール送信済みマーク ──
  const markEmailSent = async (docType) => {
    const proj = emailModal.project
    if (!proj) return
    const sentKey = `emailSent_${docType}`
    await updateDoc(doc(db, company.collection, proj.id), {
      [sentKey]: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    })
    setProjects((prev) => prev.map((p) =>
      p.id === proj.id ? { ...p, [sentKey]: new Date().toISOString() } : p
    ))
  }

  // ── 発注書用のproject生成（原価ベース） ──
  const getPurchaseProject = (project) => {
    const costItems = (project.items || []).map((it) => {
      const cost = parseFloat(it.costPrice) || parseFloat(it.unitPrice) || 0
      const qty = it.qty || it.quantity || 0
      return { ...it, unitPrice: cost, amount: cost * qty }
    })
    const costSubtotal = costItems.reduce((s, it) => s + (it.amount || 0), 0)
    const costTax = calcTax(costSubtotal, taxSettings)
    return { ...project, items: costItems, subtotal: costSubtotal, tax: costTax, total: costSubtotal + costTax }
  }

  // ── メール送信モーダルを開く ──
  const openEmailModal = async (docType, project) => {
    const docNo = await assignDocNo(docType, project)
    const proj = docType === 'purchase' ? getPurchaseProject(project) : project
    setEmailModal({
      open: true,
      project: { ...proj, [`docNo_${docType}`]: docNo },
      docType,
      originalProject: project,
    })
  }

  // ── 案件削除 ──
  const handleDelete = async (project) => {
    if (!confirm(`案件 ${project.projectNo} を削除しますか？`)) return
    try {
      await deleteDoc(doc(db, company.collection, project.id))
      setProjects((prev) => prev.filter((p) => p.id !== project.id))
    } catch (e) {
      alert('削除に失敗しました')
    }
  }

  if (!isAdmin) {
    return <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">この画面は管理者のみ使用できます</div>
  }

  return (
    <div className="max-w-6xl">
      {/* 会社切替 */}
      <div className="mb-4 w-72">
        <CompanySwitcher />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">案件管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            <span className={`font-bold ${company.text}`}>{company.name}</span> — 見積 → 工場発注 → 製造 → 納品 → 請求 → 入金 → 完了
          </p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className={`rounded-lg px-5 py-2.5 text-sm font-bold text-white ${company.bg} hover:opacity-90`}>
          + 新規案件
        </button>
      </div>

      {/* サマリー */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">全案件</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{projects.length}件</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">進行中</div>
          <div className="mt-1 text-2xl font-bold text-orange-600">
            {projects.filter((p) => !['completed'].includes(p.status)).length}件
          </div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">進行中 合計金額</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{fmtYen(activeTotal)}</div>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white px-5 py-4">
          <div className="text-xs text-gray-500">入金待ち</div>
          <div className={`mt-1 text-2xl font-bold ${statusCounts.awaiting > 0 ? 'text-pink-600' : 'text-gray-900'}`}>
            {statusCounts.awaiting || 0}件
          </div>
        </div>
      </div>

      {/* ステータスタブ */}
      <div className="mb-4 flex flex-wrap gap-1">
        <button onClick={() => setFilterStatus('all')}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            filterStatus === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}>
          すべて ({statusCounts.all})
        </button>
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setFilterStatus(s.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterStatus === s.key ? `${s.bg} ${s.text}` : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {s.icon} {s.label} ({statusCounts[s.key] || 0})
          </button>
        ))}
      </div>

      {/* 検索 */}
      <div className="mb-4">
        <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)}
          placeholder="取引先名・案件番号・件名・帳票番号・仕入先で検索..."
          className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
      </div>

      {/* 案件一覧 */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 py-12 text-center text-sm text-gray-400">
          {projects.length === 0 ? '案件がありません。「+ 新規案件」から作成してください。' : '条件に一致する案件がありません'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => {
            const st = STATUS_MAP[p.status || 'quote'] || STATUS_MAP.quote
            const isOpen = expandedId === p.id
            const statusIdx = STATUSES.findIndex((s) => s.key === (p.status || 'quote'))

            return (
              <div key={p.id} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                {/* ヘッダー行 */}
                <div className="flex cursor-pointer items-center gap-4 px-5 py-4 hover:bg-gray-50"
                  onClick={() => setExpandedId(isOpen ? null : p.id)}>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${st.bg} ${st.text}`}>
                    {st.icon} {st.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-400">{p.projectNo}</span>
                      {p.subject && <span className="text-sm font-medium text-gray-900">{p.subject}</span>}
                    </div>
                    <div className="text-sm text-gray-600">
                      {p.clientName || (p.factoryName ? `🏭 ${p.factoryName}` : '—')}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-gray-900">{fmtYen(p.total)}</div>
                    <div className="text-xs text-gray-400">{fmtDate(p.createdAt)}</div>
                  </div>
                  <span className="text-gray-400">{isOpen ? '▲' : '▼'}</span>
                </div>

                {/* ステップバー（クリックでステータス変更） */}
                <div className="border-t border-gray-100 bg-gray-50 px-5 py-2">
                  <div className="flex items-center gap-0.5">
                    {STATUSES.map((s, i) => (
                      <Fragment key={s.key}>
                        <button
                          title={`${s.label}に変更`}
                          disabled={updatingId === p.id}
                          onClick={(e) => { e.stopPropagation(); changeStatus(p, s.key) }}
                          className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] transition-all hover:scale-110 hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 disabled:opacity-50 ${
                            i < statusIdx ? 'bg-green-500 text-white'
                            : i === statusIdx ? `${st.bg} ${st.text} font-bold ring-2 ring-offset-1 ring-${company.color}-300`
                            : 'bg-gray-200 text-gray-400 hover:bg-gray-300'
                          }`}>
                          {i < statusIdx ? '✓' : s.icon}
                        </button>
                        {i < STATUSES.length - 1 && (
                          <div className={`h-0.5 flex-1 ${i < statusIdx ? 'bg-green-400' : 'bg-gray-200'}`} />
                        )}
                      </Fragment>
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between text-[9px] text-gray-400">
                    {STATUSES.map((s) => (
                      <span key={s.key} className={`text-center ${s.key === (p.status || 'quote') ? 'font-bold text-gray-600' : ''}`} style={{ width: '12.5%' }}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 展開: 詳細 */}
                {isOpen && (
                  <div className="border-t border-gray-100 px-5 py-4">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                      {/* 明細 */}
                      <div className="lg:col-span-2">
                        <h4 className="mb-2 text-xs font-bold text-gray-600">商品明細</h4>
                        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-100 text-left text-gray-500">
                              <tr>
                                <th className="px-3 py-2">品名</th>
                                <th className="px-3 py-2">品番</th>
                                <th className="px-3 py-2 text-right">数量</th>
                                <th className="px-3 py-2 text-right">単価</th>
                                <th className="px-3 py-2 text-right">金額</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(p.items || []).map((it, i) => (
                                <tr key={i} className="border-t border-gray-100">
                                  <td className="px-3 py-2 text-gray-900">{it.name}</td>
                                  <td className="px-3 py-2 font-mono text-gray-400">{it.code || '—'}</td>
                                  <td className="px-3 py-2 text-right">{it.qty}</td>
                                  <td className="px-3 py-2 text-right">{fmtYen(it.unitPrice)}</td>
                                  <td className="px-3 py-2 text-right font-medium">{fmtYen(it.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="bg-gray-50">
                              <tr className="border-t border-gray-200">
                                <td colSpan={4} className="px-3 py-2 text-right font-bold">小計</td>
                                <td className="px-3 py-2 text-right font-bold">{fmtYen(p.subtotal)}</td>
                              </tr>
                              <tr>
                                <td colSpan={4} className="px-3 py-2 text-right text-gray-500">消費税</td>
                                <td className="px-3 py-2 text-right">{fmtYen(p.tax)}</td>
                              </tr>
                              <tr className="border-t border-gray-300">
                                <td colSpan={4} className="px-3 py-2 text-right text-base font-bold">合計</td>
                                <td className="px-3 py-2 text-right text-base font-bold">{fmtYen(p.total)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>

                      {/* 案件情報 */}
                      <div className="space-y-3">
                        <div className="rounded-lg border border-gray-200 bg-white p-3">
                          <table className="w-full text-xs">
                            <tbody className="divide-y divide-gray-100">
                              <tr><td className="py-1.5 text-gray-500">取引先</td><td className="py-1.5 text-right font-medium">{p.clientName}</td></tr>
                              {p.clientPerson && <tr><td className="py-1.5 text-gray-500">担当者</td><td className="py-1.5 text-right">{p.clientPerson}</td></tr>}
                              {p.clientEmail && <tr><td className="py-1.5 text-gray-500">取引先メール</td><td className="py-1.5 text-right text-blue-600">{p.clientEmail}</td></tr>}
                              {p.factoryName && <tr><td className="py-1.5 text-gray-500">仕入れ先</td><td className="py-1.5 text-right">{p.factoryName}</td></tr>}
                              {p.factoryEmail && <tr><td className="py-1.5 text-gray-500">仕入れ先メール</td><td className="py-1.5 text-right text-blue-600">{p.factoryEmail}</td></tr>}
                              {p.destName && <tr><td className="py-1.5 text-gray-500">📍 納品先</td><td className="py-1.5 text-right">{p.destName}</td></tr>}
                              {p.destAddress && <tr><td className="py-1.5 text-gray-500">納品先住所</td><td className="py-1.5 text-right text-xs">{p.destAddress}</td></tr>}
                              {p.deliveryDate && <tr><td className="py-1.5 text-gray-500">納期</td><td className="py-1.5 text-right">{p.deliveryDate}</td></tr>}
                              <tr><td className="py-1.5 text-gray-500">作成日</td><td className="py-1.5 text-right">{fmtDate(p.createdAt)}</td></tr>
                            </tbody>
                          </table>
                        </div>

                        {p.notes && (
                          <div className="rounded-lg bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                            {p.notes}
                          </div>
                        )}

                        {/* 帳票ボタン */}
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold text-gray-600">帳票出力・送信</h4>
                          {[
                            { type: 'quote',      icon: '📝', label: '見積書' },
                            { type: 'acceptance', icon: '🤝', label: '注文請負書' },
                            { type: 'purchase',   icon: '📋', label: '発注書' },
                            { type: 'delivery',   icon: '🚚', label: '納品書' },
                            { type: 'invoice',    icon: '📄', label: '請求書' },
                            { type: 'receipt',    icon: '🧾', label: '領収書' },
                          ].map(({ type, icon, label }) => {
                            const sentAt = p[`emailSent_${type}`]
                            const faxSentAt = p[`faxSent_${type}`]
                            const docNoVal = p[`docNo_${type}`]
                            return (
                              <div key={type} className="flex items-center gap-1.5">
                                <button onClick={() => printDoc(type, p)}
                                  className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 text-left">
                                  {icon} {label}
                                  {docNoVal && <span className="ml-1 font-mono text-[10px] text-gray-400">{docNoVal}</span>}
                                </button>
                                <button onClick={() => downloadDocPdf(type, p)}
                                  title={`${label}をPDFダウンロード`}
                                  className="rounded-lg border border-orange-300 bg-orange-50 px-2 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100">
                                  📥 PDF
                                </button>
                                <button onClick={() => openEmailModal(type, p)}
                                  className={`rounded-lg px-2 py-1.5 text-xs font-medium ${
                                    sentAt
                                      ? 'border border-green-300 bg-green-50 text-green-700'
                                      : 'border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                                  }`}>
                                  {sentAt ? '✅ 送信済' : '📧 送信'}
                                </button>
                                <button onClick={() => openFaxModal(type, p)}
                                  title={`${label}をFAX送信`}
                                  className={`rounded-lg px-2 py-1.5 text-xs font-medium ${
                                    faxSentAt
                                      ? 'border border-green-300 bg-green-50 text-green-700'
                                      : 'border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100'
                                  }`}>
                                  {faxSentAt ? '✅ FAX済' : '📠 FAX'}
                                </button>
                              </div>
                            )
                          })}
                        </div>

                        {/* ステータス変更 */}
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold text-gray-600">ステータス変更</h4>
                          <div className="grid grid-cols-2 gap-1.5">
                            {STATUSES.map((s) => (
                              <button key={s.key}
                                onClick={() => changeStatus(p, s.key)}
                                disabled={updatingId === p.id || s.key === (p.status || 'quote')}
                                className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors disabled:opacity-40 ${
                                  s.key === (p.status || 'quote')
                                    ? `${s.bg} ${s.text} ring-2 ring-offset-1 ring-gray-300`
                                    : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                                }`}>
                                {s.icon} {s.label}
                              </button>
                            ))}
                          </div>
                          {(p.status === 'quote' || p.status === 'completed') && (
                            <button onClick={() => handleDelete(p)}
                              className="mt-2 w-full rounded-lg border border-red-300 py-2 text-xs text-red-500 hover:bg-red-50">
                              🗑 案件を削除
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 新規作成モーダル */}
      <CreateProjectModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onSave={handleCreate}
        company={company}
        bpClients={bpClients}
        bpProducts={bpProducts}
        bpSuppliers={bpSuppliers}
        bpDestinations={bpDestinations}
      />

      {/* メール送信モーダル */}
      <SendEmailModal
        isOpen={emailModal.open}
        onClose={() => setEmailModal({ open: false, project: null, docType: null })}
        project={emailModal.project}
        docType={emailModal.docType}
        companyInfo={companyInfo}
        taxSettings={taxSettings}
        stampDataUrl={stampDataUrl}
        companyKey={company.key}
        onSent={markEmailSent}
      />

      {/* FAX送信モーダル */}
      {faxModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h3 className="mb-1 text-lg font-bold text-gray-900">
              📠 FAX送信 - {DOC_TYPES[faxModal.docType]?.title || '帳票'}
            </h3>
            <p className="mb-4 text-xs text-gray-500">
              案件: {faxModal.project?.projectNo} / {faxModal.project?.clientName}
            </p>

            <label className="mb-1 block text-sm font-medium text-gray-700">送信先FAX番号</label>
            <input
              type="tel"
              value={faxNumber}
              onChange={(e) => setFaxNumber(e.target.value)}
              placeholder="03-1234-5678"
              className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <p className="mb-4 text-xs text-gray-500">
              ※ ハイフンあり/なしどちらでもOK。国内番号は自動的に +81 に変換されます。
            </p>

            <div className="mb-4 rounded-lg bg-yellow-50 p-3 text-xs text-yellow-800">
              送信すると Telnyx 経由でFAX送信されます。料金：1ページ約1円（従量課金）
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setFaxModal({ open: false, project: null, docType: null }); setFaxNumber('') }}
                disabled={faxSending}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                キャンセル
              </button>
              <button
                onClick={sendFaxForDoc}
                disabled={faxSending || !faxNumber.trim()}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50">
                {faxSending ? '送信中...' : '📠 FAX送信'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
