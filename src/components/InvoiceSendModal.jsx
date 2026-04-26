import React, { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase.js'
import { generateInvoicePdfBase64 } from '../lib/generateInvoicePdf.js'
import { validateAddressList } from '../lib/emailValidation.js'

// 完全自動送信ではなく、人間が「宛先・件名・本文」を確認してから送信するための
// プレビュー兼送信モーダル。InvoiceManage の一覧から起動する。
//
// props:
//   invoice           : invoices ドキュメント (id 必須)
//   companyInfoFallback: settings/company の中身（invoice.companyInfo が空のとき使う）
//   stampDataUrlFallback: settings/companyStamp.dataUrl のフォールバック
//   onClose()         : モーダルを閉じる
//   onSent(result)    : 送信成功時。一覧の status を 'sent' に更新するため
//   retryFromLog      : 再送モード時の元ログ（任意）。{ id, to, cc, subject, ... }

// UI 表示用の送信元ラベル（変更不可フィールドに表示）。
// functions/sendInvoice.js の DEFAULT_FROM_NAME / DEFAULT_FROM_EMAIL と一致させること。
const DEFAULT_FROM_LABEL = 'inv@royaltrust.jp（ロイヤルトラスト株式会社経理部）'

function fmtYen(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString() + '円'
}

function monthLabel(month) {
  if (!month) return ''
  const [y, m] = month.split('-')
  return `${y}年${parseInt(m, 10)}月`
}

function buildDefaultSubject(invoice) {
  return `【ロイヤルトラスト株式会社】${monthLabel(invoice.month)}分 ご請求書送付のご案内`
}

function buildDefaultBody(invoice) {
  const dealer = invoice.dealerName || invoice.dealerCode || ''
  const ml = monthLabel(invoice.month)
  const amt = fmtYen(invoice.grandTotal)
  return [
    `${dealer} 御中`,
    '',
    'いつも大変お世話になっております。',
    'ロイヤルトラスト株式会社です。',
    '',
    `${ml}分のご請求書を本メールに添付いたします。`,
    `ご請求金額（税込）: ${amt}`,
    '',
    'ご査収のほど、よろしくお願いいたします。',
    '',
    '内容にご不明な点がございましたら、本メールへご返信ください。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    'ロイヤルトラスト株式会社',
    '〒150-0012 東京都渋谷区広尾5-24-3',
    'TEL: 03-3441-7839',
    'Email: info@royaltrust.jp',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n')
}

export default function InvoiceSendModal({
  invoice,
  companyInfoFallback,
  stampDataUrlFallback,
  onClose,
  onSent,
  retryFromLog,
}) {
  const [to, setTo] = useState(retryFromLog?.to || '')
  const [cc, setCc] = useState(retryFromLog?.cc || '')
  const [bcc, setBcc] = useState(retryFromLog?.bcc || '')
  const [subject, setSubject] = useState(retryFromLog?.subject || buildDefaultSubject(invoice))
  const [body, setBody] = useState(retryFromLog?.bodyText || buildDefaultBody(invoice))

  const [pdfMeta, setPdfMeta] = useState(null) // { fileName, sizeKB }
  const [pdfBase64, setPdfBase64] = useState(null)
  const [pdfError, setPdfError] = useState('')
  const [pdfBuilding, setPdfBuilding] = useState(true)

  const [resolvingEmail, setResolvingEmail] = useState(!retryFromLog)
  const [emailHint, setEmailHint] = useState('')

  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  // 1) 代理店メールを allowedEmails から解決（再送モード時はスキップ）
  useEffect(() => {
    if (retryFromLog) return
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, 'allowedEmails'),
            where('dealerCode', '==', invoice.dealerCode),
            where('role', '==', 'dealer')
          )
        )
        if (cancelled) return
        if (snap.empty) {
          setEmailHint(`代理店 ${invoice.dealerCode} のメールアドレスが allowedEmails に登録されていません`)
        } else {
          const data = snap.docs[0].data()
          const email = data.email || snap.docs[0].id
          setTo((cur) => cur || email)
          setEmailHint(`allowedEmails から自動取得: ${email}`)
        }
      } catch (e) {
        if (!cancelled) setEmailHint('メールアドレス自動取得に失敗: ' + e.message)
      } finally {
        if (!cancelled) setResolvingEmail(false)
      }
    })()
    return () => { cancelled = true }
  }, [invoice.dealerCode, retryFromLog])

  // 2) PDFを事前生成（モーダルを開いた時点で1回だけ）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setPdfBuilding(true)
        const inv = {
          ...invoice,
          companyInfo: invoice.companyInfo || companyInfoFallback,
          stampDataUrl: invoice.stampDataUrl || stampDataUrlFallback,
        }
        const { base64, fileName } = await generateInvoicePdfBase64(inv)
        if (cancelled) return
        setPdfBase64(base64)
        // base64 → 概算バイト数（4文字 = 3バイト）
        const sizeKB = Math.round((base64.length * 3) / 4 / 1024)
        setPdfMeta({ fileName, sizeKB })
      } catch (e) {
        if (!cancelled) setPdfError('PDF生成に失敗しました: ' + e.message)
      } finally {
        if (!cancelled) setPdfBuilding(false)
      }
    })()
    return () => { cancelled = true }
  }, [invoice, companyInfoFallback, stampDataUrlFallback])

  // クライアント側バリデーション（サーバー側でも同じロジックで再検証する）
  const validation = useMemo(() => {
    const toCheck = validateAddressList(to)
    if (toCheck.addresses.length === 0) {
      return { ok: false, message: '宛先（To）を入力してください' }
    }
    if (!toCheck.valid) {
      return { ok: false, message: `宛先のメール形式が不正です: ${toCheck.invalid}` }
    }
    if (cc.trim()) {
      const ccCheck = validateAddressList(cc)
      if (!ccCheck.valid) {
        return { ok: false, message: `CC のメール形式が不正です: ${ccCheck.invalid}` }
      }
    }
    if (bcc.trim()) {
      const bccCheck = validateAddressList(bcc)
      if (!bccCheck.valid) {
        return { ok: false, message: `BCC のメール形式が不正です: ${bccCheck.invalid}` }
      }
    }
    return { ok: true, message: '' }
  }, [to, cc, bcc])

  const canSend = useMemo(() => {
    return validation.ok && !!subject && !!body && !!pdfBase64 && !sending && !pdfBuilding
  }, [validation.ok, subject, body, pdfBase64, sending, pdfBuilding])

  const handleSend = async () => {
    setError('')
    if (!validation.ok) {
      setError(validation.message)
      setConfirming(false)
      return
    }
    setSending(true)
    try {
      const fn = httpsCallable(functions, 'sendInvoice')
      const res = await fn({
        invoiceId: invoice.id,
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject,
        bodyText: body,
        pdfBase64,
        pdfFileName: pdfMeta?.fileName,
        retryOfLogId: retryFromLog?.id || undefined,
      })
      onSent && onSent(res.data)
    } catch (e) {
      console.error('sendInvoice失敗:', e)
      setError(e?.message || '送信に失敗しました')
    } finally {
      setSending(false)
      setConfirming(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">
            請求書メール送信プレビュー
            {retryFromLog && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">再送</span>}
          </h3>
          <button
            onClick={onClose}
            disabled={sending}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>

        {/* 請求書情報サマリ */}
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <div>対象: <span className="font-bold text-gray-900">{invoice.dealerName || invoice.dealerCode}</span> ／ {monthLabel(invoice.month)}</div>
          <div>請求金額（税込）: <span className="font-bold text-emerald-700">{fmtYen(invoice.grandTotal)}</span> ／ 注文件数: {invoice.orderCount || (invoice.orders || []).length}件</div>
          {invoice.invoiceNo && <div>請求番号: {invoice.invoiceNo}</div>}
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">差出人（変更不可）</label>
            <input
              type="text"
              value={DEFAULT_FROM_LABEL}
              disabled
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">宛先（To）<span className="text-red-500">*</span></label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={resolvingEmail ? '代理店メールを取得中…' : 'dealer@example.com'}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            {emailHint && <div className="mt-1 text-xs text-gray-400">{emailHint}</div>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">CC（任意）</label>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="info@royaltrust.jp"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">BCC（任意）</label>
              <input
                type="text"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                placeholder=""
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">件名 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">本文 <span className="text-red-500">*</span></label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm leading-relaxed"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">添付ファイル</label>
            {pdfBuilding && <div className="text-xs text-gray-500">PDF生成中…</div>}
            {pdfError && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{pdfError}</div>}
            {pdfMeta && !pdfError && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                📎 <span className="font-medium">{pdfMeta.fileName}</span>
                <span className="ml-2 text-gray-400">（約 {pdfMeta.sizeKB} KB）</span>
              </div>
            )}
          </div>
        </div>

        {/* バリデーションエラー（リアルタイム表示） */}
        {!validation.ok && (to || cc || bcc) && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {validation.message}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={sending}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={() => setConfirming(true)}
            disabled={!canSend}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            title={!canSend && !validation.ok ? validation.message : ''}
          >
            {sending ? '送信中…' : 'この内容で送信'}
          </button>
        </div>

        {/* 二段階確認モーダル：誤送信防止 */}
        {confirming && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <h4 className="mb-3 text-base font-bold text-gray-900">本当に送信しますか？</h4>
              <p className="mb-4 text-sm text-gray-600">
                以下の宛先に請求書PDFが SendGrid 経由で実送信されます。
              </p>
              <div className="mb-4 space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <div>To: <span className="font-mono">{to}</span></div>
                {cc && <div>Cc: <span className="font-mono">{cc}</span></div>}
                {bcc && <div>Bcc: <span className="font-mono">{bcc}</span></div>}
                <div>件名: {subject}</div>
                <div>添付: {pdfMeta?.fileName}</div>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setConfirming(false)}
                  disabled={sending}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  戻る
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending}
                  className="rounded-lg bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {sending ? '送信中…' : '送信を実行する'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
