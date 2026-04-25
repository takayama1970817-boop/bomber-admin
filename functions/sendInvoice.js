// functions/sendInvoice.js
// 請求書（invoices コレクション・全代理店共通）を SendGrid 経由で送信し、
// invoiceEmailLogs に監査ログを残す Cloud Function。
//
// 適用範囲:
// - 全代理店（KBグループ A / B / C 不問）の請求書を送信できる汎用基盤。
// - 初期利用対象はグループC（請求書発行・KBなし）だが、関数自体は
//   invoiceId 単位で動作するため、どのグループの請求書でも送信可能。
// - 将来的な一括送信は本関数を invoiceId 単位でループ呼び出しすれば実現可能
//   （sendInvoiceBulk ラッパーを別関数として追加する想定）。
//
// 設計判断:
// - SendGrid を採用（既存の SES フローとは別。inv@royaltrust.jp の認証済み
//   送信元 + em8543.royaltrust.jp のドメイン認証済みのため、到達性が高い）
// - PDF はクライアント側で生成して base64 で渡す（既存 notifyKickback と同じ
//   アーキテクチャ。サーバー側で再生成しないので Functions の Cold Start や
//   Puppeteer 依存を避けられる）
// - 完全自動送信ではなく、UI 側でプレビューモーダル → 確認後に呼び出す
// - 失敗時は invoiceEmailLogs に status='failed' で記録し、UI から再送可能
// - 成功時は invoices.{id}.lastEmailedAt 更新 + status='draft' のときのみ
//   'sent' に自動昇格（draft 以外のステータスは触らない）

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const sgMail = require('@sendgrid/mail')

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY')

const DEFAULT_FROM_EMAIL = 'inv@royaltrust.jp'
const DEFAULT_FROM_NAME = 'ロイヤルトラスト株式会社'

const sendInvoice = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [SENDGRID_API_KEY],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }
    const callerEmail = callerDoc.data().email || ''

    const {
      invoiceId,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      pdfBase64,
      pdfFileName,
      replyTo,
      retryOfLogId,
    } = request.data || {}

    if (!invoiceId || !to || !subject || !bodyText || !pdfBase64 || !pdfFileName) {
      throw new HttpsError(
        'invalid-argument',
        'invoiceId / to / subject / bodyText / pdfBase64 / pdfFileName は必須です'
      )
    }

    const invoiceRef = db.collection('invoices').doc(invoiceId)
    const invoiceSnap = await invoiceRef.get()
    if (!invoiceSnap.exists) {
      throw new HttpsError('not-found', `invoices/${invoiceId} が見つかりません`)
    }
    const invoice = invoiceSnap.data()

    const apiKey = SENDGRID_API_KEY.value()
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'SENDGRID_API_KEY が未設定です')
    }
    sgMail.setApiKey(apiKey)

    const msg = {
      to,
      from: { email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME },
      subject,
      text: bodyText,
      html: bodyHtml || bodyText.replace(/\n/g, '<br>'),
      attachments: [
        {
          content: pdfBase64,
          filename: pdfFileName,
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    }
    if (cc) msg.cc = cc
    if (bcc) msg.bcc = bcc
    if (replyTo) msg.replyTo = replyTo

    const baseLog = {
      invoiceId,
      dealerCode: invoice.dealerCode || '',
      dealerName: invoice.dealerName || '',
      month: invoice.month || '',
      grandTotal: invoice.grandTotal ?? null,
      to,
      cc: cc || '',
      bcc: bcc || '',
      subject,
      bodyText,
      bodyHtml: bodyHtml || '',
      pdfFileName,
      sentBy: request.auth.uid,
      sentByEmail: callerEmail,
      sentAt: FieldValue.serverTimestamp(),
      provider: 'sendgrid',
      fromEmail: DEFAULT_FROM_EMAIL,
      fromName: DEFAULT_FROM_NAME,
      retryOfLogId: retryOfLogId || null,
    }

    try {
      const [response] = await sgMail.send(msg)

      const logRef = await db.collection('invoiceEmailLogs').add({
        ...baseLog,
        status: 'success',
        providerStatusCode: response?.statusCode || null,
        providerMessageId: response?.headers?.['x-message-id'] || null,
        error: null,
      })

      const update = {
        lastEmailedAt: FieldValue.serverTimestamp(),
        lastEmailLogId: logRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      }
      if (invoice.status === 'draft') {
        update.status = 'sent'
        update.sentAt = FieldValue.serverTimestamp()
      }
      await invoiceRef.update(update)

      return {
        success: true,
        logId: logRef.id,
        statusCode: response?.statusCode || null,
      }
    } catch (err) {
      console.error('SendGrid送信エラー:', err?.response?.body || err)
      const errMessage =
        err?.response?.body?.errors?.[0]?.message ||
        err?.message ||
        'unknown error'

      try {
        await db.collection('invoiceEmailLogs').add({
          ...baseLog,
          status: 'failed',
          providerStatusCode: err?.code || err?.response?.statusCode || null,
          providerMessageId: null,
          error: errMessage,
        })
      } catch (logErr) {
        console.error('失敗ログ書き込み失敗:', logErr)
      }

      throw new HttpsError('internal', 'メール送信に失敗しました: ' + errMessage)
    }
  }
)

module.exports = { sendInvoice }
