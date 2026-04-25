// functions/notifyKickback.js
// キックバック清算書の通知メール送信

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses')

/**
 * kickbackId を kickbacks コレクションで自動探索（dealerCode + month 一致）
 * 旧クライアントが kickbackId を渡さない場合のフォールバック
 */
async function findKickbackId(db, dealerCode, month) {
  const snap = await db.collection('kickbacks')
    .where('dealerCode', '==', dealerCode)
    .where('month', '==', month)
    .get()
  if (snap.empty) return null
  // pdf_ready 優先 → なければ最新
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }))
  const pdfReady = docs.find((d) => d.data.phase === 'pdf_ready' || d.data.pdfUrl)
  return (pdfReady || docs[0]).id
}

/**
 * 清算書の通知メールを代理店に送信（PDF添付対応）
 * @param {string} data.dealerCode - 代理店コード
 * @param {string} data.dealerName - 代理店名
 * @param {string} data.month - 対象月 (例: "2026-04")
 * @param {number} data.grandTotal - 清算額（税込）
 * @param {string} [data.pdfBase64] - PDF（base64エンコード）
 * @param {string} [data.pdfFileName] - PDFファイル名
 */
const notifyKickback = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ログインが必要です')

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    const { dealerCode, dealerName, month, grandTotal, pdfBase64, pdfFileName, testEmail, ccEmail } = request.data
    let { kickbackId } = request.data
    if (!dealerCode || !month) {
      throw new HttpsError('invalid-argument', 'dealerCode と month は必須です')
    }

    // PR-A: kickbackId が無ければ自動探索（旧クライアント互換）
    // testEmail 指定（テスト送信）のときは kickbacks への書き戻しを行わない
    const isTestSend = !!testEmail
    if (!isTestSend && !kickbackId) {
      kickbackId = await findKickbackId(db, dealerCode, month)
    }

    // テスト送信先が指定されていればそちらを使用、なければ代理店のメールを取得
    let dealerEmail = testEmail
    if (!dealerEmail) {
      const emailSnap = await db.collection('allowedEmails')
        .where('dealerCode', '==', dealerCode)
        .where('role', '==', 'dealer')
        .get()

      if (emailSnap.empty) {
        throw new HttpsError('not-found', `代理店 ${dealerCode} のメールアドレスが見つかりません`)
      }

      dealerEmail = emailSnap.docs[0].data().email || emailSnap.docs[0].id
      if (!dealerEmail) {
        throw new HttpsError('not-found', '代理店のメールアドレスが未設定です')
      }
    }

    // SES設定取得
    const settingsDoc = await db.collection('settings').doc('rt_company').get()
    const settings = settingsDoc.exists ? settingsDoc.data() : {}
    const sesRegion = settings.sesRegion || 'ap-northeast-1'
    const sesAccessKey = settings.sesAccessKeyId
    const sesSecretKey = settings.sesSecretAccessKey

    if (!sesAccessKey || !sesSecretKey) {
      throw new HttpsError('failed-precondition', 'SES設定が未設定です')
    }

    const sesClient = new SESClient({
      region: sesRegion,
      credentials: { accessKeyId: sesAccessKey, secretAccessKey: sesSecretKey },
    })

    const senderName = settings.companyName || 'VAVITTE'
    const senderEmail = settings.email || 'info@royaltrust.jp'
    const portalUrl = 'https://bomber-admin.web.app/dealer'

    // 月表示整形
    const [y, m] = month.split('-')
    const monthLabel = `${y}年${parseInt(m)}月`
    const amountLabel = grandTotal ? `¥${Number(grandTotal).toLocaleString()}` : ''

    const subject = `【${senderName}】${monthLabel}分 清算書のご案内`

    const textBody = [
      `${dealerName || dealerCode} 様`,
      '',
      `いつもお世話になっております。`,
      `${senderName}です。`,
      '',
      `${monthLabel}分の清算書をご用意いたしました。`,
      amountLabel ? `清算額（税込）: ${amountLabel}` : '',
      '',
      `以下のURLから代理店ポータルにログインし、`,
      `清算書の確認・PDFダウンロードが可能です。`,
      '',
      portalUrl,
      '',
      `ご不明な点がございましたらお気軽にご連絡ください。`,
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      senderName,
      settings.email ? `Email: ${settings.email}` : '',
      settings.tel ? `TEL: ${settings.tel}` : '',
      `━━━━━━━━━━━━━━━━━━━━`,
    ].filter(Boolean).join('\r\n')

    const htmlBody = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
  <div style="background:#4f46e5;padding:28px 32px;">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:bold;">${monthLabel}分 清算書のご案内</h1>
  </div>
  <div style="padding:32px;">
    <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.8;">
      ${dealerName || dealerCode} 様<br><br>
      いつもお世話になっております。<br>
      ${monthLabel}分の清算書をご用意いたしました。
    </p>
    ${amountLabel ? `
    <div style="background:#f0f0ff;border-radius:8px;padding:16px 20px;margin:20px 0;text-align:center;">
      <div style="font-size:12px;color:#666;">清算額（税込）</div>
      <div style="font-size:28px;font-weight:bold;color:#4f46e5;margin-top:4px;">${amountLabel}</div>
    </div>
    ` : ''}
    <p style="margin:16px 0;font-size:14px;color:#555;line-height:1.8;">
      以下のボタンから代理店ポータルにログインし、<br>
      清算書の確認・PDFダウンロードが可能です。
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${portalUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:15px;font-weight:bold;">
        清算書を確認する
      </a>
    </div>
    <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6;">
      ご不明な点がございましたらお気軽にご連絡ください。
    </p>
  </div>
  <div style="background:#f9fafb;padding:16px 32px;font-size:11px;color:#aaa;text-align:center;">
    ${senderName}${settings.email ? ` | ${settings.email}` : ''}${settings.tel ? ` | ${settings.tel}` : ''}
  </div>
</div>
</body>
</html>`

    // MIME構築
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`

    const hasPdf = pdfBase64 && pdfFileName

    const headerLines = [
      `From: =?UTF-8?B?${Buffer.from(senderName).toString('base64')}?= <${senderEmail}>`,
      `To: ${dealerEmail}`,
    ]
    if (ccEmail) headerLines.push(`Cc: ${ccEmail}`)
    headerLines.push(
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      hasPdf
        ? `Content-Type: multipart/mixed; boundary="${boundary}"`
        : `Content-Type: multipart/alternative; boundary="${boundary}"`,
    )
    const headers = headerLines.join('\r\n')

    let rawMessage

    if (hasPdf) {
      // PDF添付あり: multipart/mixed（本文 + 添付）
      const textPart = [
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        '',
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(textBody).toString('base64'),
        '',
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlBody).toString('base64'),
        '',
        `--${altBoundary}--`,
      ].join('\r\n')

      const encodedFileName = `=?UTF-8?B?${Buffer.from(pdfFileName).toString('base64')}?=`
      const pdfPart = [
        `--${boundary}`,
        `Content-Type: application/pdf; name="${encodedFileName}"`,
        `Content-Disposition: attachment; filename="${encodedFileName}"`,
        'Content-Transfer-Encoding: base64',
        '',
        pdfBase64,
      ].join('\r\n')

      rawMessage = [headers, '', textPart, '', pdfPart, '', `--${boundary}--`].join('\r\n')
    } else {
      // PDF添付なし: 従来通り
      const textPart = [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(textBody).toString('base64'),
      ].join('\r\n')

      const htmlPart = [
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlBody).toString('base64'),
      ].join('\r\n')

      rawMessage = [headers, '', textPart, '', htmlPart, '', `--${boundary}--`].join('\r\n')
    }

    const destinations = [dealerEmail]
    if (ccEmail) destinations.push(ccEmail)
    try {
      await sesClient.send(new SendRawEmailCommand({
        Source: `${senderName} <${senderEmail}>`,
        Destinations: destinations,
        RawMessage: { Data: Buffer.from(rawMessage) },
      }))
    } catch (err) {
      console.error('SES送信エラー:', err)
      // PR-A: 失敗時も Firestore に状態を残す（kickbackId が確定している場合のみ）
      if (kickbackId && !isTestSend) {
        try {
          await db.collection('kickbacks').doc(kickbackId).set({
            mailStatus: 'failed',
            mailError: String(err?.message || err).slice(0, 500),
            mailLastAttemptAt: FieldValue.serverTimestamp(),
          }, { merge: true })
        } catch (writeErr) {
          console.error('mailStatus 書き戻し失敗:', writeErr)
        }
      }
      throw new HttpsError('internal', 'メール送信に失敗しました: ' + err.message)
    }

    // PR-A: 成功時は mailStatus / mailSentAt / mailRecipients を Firestore に永続化
    // テスト送信（testEmail 指定）は本番状態を汚さないため書き込まない
    if (kickbackId && !isTestSend) {
      try {
        await db.collection('kickbacks').doc(kickbackId).set({
          mailStatus: 'sent',
          mailSentAt: FieldValue.serverTimestamp(),
          mailRecipients: destinations,
          mailError: null,
        }, { merge: true })
      } catch (writeErr) {
        console.error('mailStatus 書き戻し失敗:', writeErr)
      }
    }

    return { success: true, email: dealerEmail, kickbackId: kickbackId || null }
  }
)

module.exports = { notifyKickback }
