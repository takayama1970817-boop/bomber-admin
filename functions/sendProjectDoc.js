// functions/sendProjectDoc.js
// 帳票をメールで送信する Cloud Function

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore } = require('firebase-admin/firestore')
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses')

/**
 * 帳票HTML をメールで送信
 * @param {string} data.to - 宛先メールアドレス
 * @param {string} data.cc - CC（自社メール）
 * @param {string} data.subject - 件名
 * @param {string} data.html - 帳票HTML本文
 * @param {string} data.fromName - 差出人名
 * @param {string} data.fromEmail - 差出人メールアドレス
 * @param {string} data.companyKey - 会社キー (rt or rc)
 */
const sendProjectDoc = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 30 },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }

    // 管理者チェック
    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master', 'staff'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '権限がありません')
    }

    const { to, cc, subject, html, fromName, fromEmail, companyKey } = request.data

    if (!to || !subject || !html) {
      throw new HttpsError('invalid-argument', '宛先、件名、本文は必須です')
    }

    // SMTP設定をFirestoreから取得
    const settingsDoc = await db.collection('settings').doc(`${companyKey || 'rt'}_company`).get()
    const settings = settingsDoc.exists ? settingsDoc.data() : {}

    // AWS SES設定（Firestoreから取得、なければ環境変数）
    const sesRegion = settings.sesRegion || process.env.SES_REGION || 'ap-northeast-1'
    const sesAccessKey = settings.sesAccessKeyId || process.env.SES_ACCESS_KEY_ID
    const sesSecretKey = settings.sesSecretAccessKey || process.env.SES_SECRET_ACCESS_KEY

    if (!sesAccessKey || !sesSecretKey) {
      throw new HttpsError('failed-precondition', 'メール送信設定（AWS SES）が未設定です。基本設定からSESのアクセスキーを設定してください。')
    }

    const sesClient = new SESClient({
      region: sesRegion,
      credentials: {
        accessKeyId: sesAccessKey,
        secretAccessKey: sesSecretKey,
      },
    })

    const senderName = fromName || settings.companyName || 'ロイヤルトラスト株式会社'
    const senderEmail = fromEmail || settings.email || 'info@royaltrust.jp'

    // MIME形式のメール作成
    const boundary = `boundary_${Date.now()}`
    const toHeader = to
    const ccHeader = cc || ''
    const headers = [
      `From: =?UTF-8?B?${Buffer.from(senderName).toString('base64')}?= <${senderEmail}>`,
      `To: ${toHeader}`,
      ccHeader ? `Cc: ${ccHeader}` : '',
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].filter(Boolean).join('\r\n')

    // テキスト版（簡易）
    const textPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`${subject}\n\n本メールはシステムから自動送信されています。\n添付の帳票をご確認ください。`).toString('base64'),
    ].join('\r\n')

    // HTML版
    const htmlPart = [
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html).toString('base64'),
    ].join('\r\n')

    const rawMessage = [
      headers,
      '',
      textPart,
      '',
      htmlPart,
      '',
      `--${boundary}--`,
    ].join('\r\n')

    try {
      const destinations = [to]
      if (cc) destinations.push(cc)

      await sesClient.send(new SendRawEmailCommand({
        Source: `${senderName} <${senderEmail}>`,
        Destinations: destinations,
        RawMessage: { Data: Buffer.from(rawMessage) },
      }))

      return { success: true, message: `${to} にメールを送信しました` }
    } catch (error) {
      console.error('SES送信エラー:', error)
      throw new HttpsError('internal', 'メール送信に失敗しました: ' + error.message)
    }
  }
)

module.exports = { sendProjectDoc }
