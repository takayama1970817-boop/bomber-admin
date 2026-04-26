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
//
// SendGrid 基盤の役割分担（重要）:
// - 本 Function は「請求書送信専用」。From: inv@royaltrust.jp 固定。
// - 将来的にメルマガ送信（sendEmailCampaign）や受信処理（receiveInboundEmail）
//   を追加する想定だが、それぞれ用途・送信元・ログ collection・配信停止管理が
//   異なるため **別 Function として実装する**。
// - 本 Function の DEFAULT_FROM_* 定数を SendGrid 全体の共通仕様として
//   再利用しないこと。
// - 共通利用してよいのは以下のみ:
//   1) defineSecret('SENDGRID_API_KEY')（SendGrid API キー自体）
//   2) functions/lib/emailValidation.js（アドレス検証ユーティリティ）
//   3) sgMail.setApiKey() の呼び出しパターン
// - 各メール用途ごとに自身の From / 件名規約 / ログスキーマ / 検証ルールを
//   明示的に定義する設計とする。

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const sgMail = require('@sendgrid/mail')
const { validateAddressList } = require('./lib/emailValidation')

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY')

// 請求書メール専用の送信元。他用途（メルマガ等）では別アドレスを別 Function で
// 定義すること。
// From 名は「経理部」を明記し、受信側で請求書メールであることを一目で判別できる
// ようにする（メルマガ・営業メール等と混同されないため）。
const DEFAULT_FROM_EMAIL = 'inv@royaltrust.jp'
const DEFAULT_FROM_NAME = 'ロイヤルトラスト株式会社経理部'

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

    // === メールアドレス検証（SendGrid 呼び出し前に弾く）===
    // To は最低1件必須、CC/BCC は任意だが指定があれば全アドレスが形式適合必須。
    const toCheck = validateAddressList(to)
    if (toCheck.addresses.length === 0) {
      throw new HttpsError('invalid-argument', '宛先（To）が空です')
    }
    if (!toCheck.valid) {
      throw new HttpsError(
        'invalid-argument',
        `宛先（To）のメールアドレス形式が不正です: ${toCheck.invalid}`
      )
    }
    const ccCheck = validateAddressList(cc)
    if (cc && !ccCheck.valid) {
      throw new HttpsError(
        'invalid-argument',
        `CC のメールアドレス形式が不正です: ${ccCheck.invalid}`
      )
    }
    const bccCheck = validateAddressList(bcc)
    if (bcc && !bccCheck.valid) {
      throw new HttpsError(
        'invalid-argument',
        `BCC のメールアドレス形式が不正です: ${bccCheck.invalid}`
      )
    }
    if (replyTo) {
      const replyCheck = validateAddressList(replyTo)
      if (!replyCheck.valid || replyCheck.addresses.length === 0) {
        throw new HttpsError(
          'invalid-argument',
          `Reply-To のメールアドレス形式が不正です: ${replyTo}`
        )
      }
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

    // パース済みアドレスを SendGrid に渡す（カンマ区切りなどの揺れを正規化）。
    const msg = {
      to: toCheck.addresses.length === 1 ? toCheck.addresses[0] : toCheck.addresses,
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
    if (cc && ccCheck.addresses.length > 0) {
      msg.cc = ccCheck.addresses.length === 1 ? ccCheck.addresses[0] : ccCheck.addresses
    }
    if (bcc && bccCheck.addresses.length > 0) {
      msg.bcc = bccCheck.addresses.length === 1 ? bccCheck.addresses[0] : bccCheck.addresses
    }
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
