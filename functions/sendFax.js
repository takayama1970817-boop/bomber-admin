// functions/sendFax.js
// Telnyx Fax API 経由でFAX送信する Cloud Function
//
// 必要な環境設定:
//   1. Telnyx アカウント作成（https://telnyx.com/）
//   2. Telnyx Portal で以下を取得:
//      - API Key (Secret)
//      - Fax Connection ID (Messaging → Fax Applications で作成)
//      - Fax番号（日本03/050 or US番号を購入）
//   3. Firebase Secrets に設定:
//      firebase functions:secrets:set TELNYX_API_KEY
//      firebase functions:secrets:set TELNYX_FAX_FROM    (例: +815012345678)
//      firebase functions:secrets:set TELNYX_CONNECTION_ID

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const TELNYX_API_KEY = defineSecret('TELNYX_API_KEY')
const TELNYX_FAX_FROM = defineSecret('TELNYX_FAX_FROM')
const TELNYX_CONNECTION_ID = defineSecret('TELNYX_CONNECTION_ID')

// 日本のFAX番号をE.164形式に変換 (例: 03-1234-5678 → +81312345678)
function toE164Japan(number) {
  if (!number) return ''
  let n = String(number).replace(/[^\d+]/g, '')
  if (n.startsWith('+')) return n
  if (n.startsWith('0')) return '+81' + n.slice(1)
  return '+81' + n
}

const sendFax = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 60,
    secrets: [TELNYX_API_KEY, TELNYX_FAX_FROM, TELNYX_CONNECTION_ID],
  },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master', 'staff'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '権限がありません')
    }

    const {
      pdfBase64,   // PDFファイルのbase64文字列
      fileName,    // PDFファイル名
      toNumber,    // 送信先FAX番号
      projectId,   // 案件ID（ログ用、任意）
      docType,     // 帳票種別（ログ用、任意）
      companyKey,  // 会社キー（ログ用、任意）
    } = request.data

    if (!pdfBase64 || !toNumber) {
      throw new HttpsError('invalid-argument', 'PDFと送信先は必須です')
    }

    const toE164 = toE164Japan(toNumber)
    if (!/^\+\d{10,15}$/.test(toE164)) {
      throw new HttpsError('invalid-argument', '送信先FAX番号が不正です: ' + toNumber)
    }

    // 1. PDFをFirebase Storageにアップロード（Telnyxが取得するための一時URL）
    const bucket = getStorage().bucket()
    const safeName = (fileName || 'fax.pdf').replace(/[^\w.\-]/g, '_')
    const path = `fax-temp/${request.auth.uid}/${Date.now()}_${safeName}`
    const file = bucket.file(path)
    const buffer = Buffer.from(pdfBase64, 'base64')

    await file.save(buffer, {
      contentType: 'application/pdf',
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600' },
    })

    // Telnyxが取得するための署名付きURL（24時間有効）
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000,
    })

    // 2. Telnyx Fax API を呼び出し
    const fromNumber = TELNYX_FAX_FROM.value()
    const connectionId = TELNYX_CONNECTION_ID.value()
    const apiKey = TELNYX_API_KEY.value()

    if (!fromNumber || !connectionId || !apiKey) {
      throw new HttpsError('failed-precondition', 'Telnyx設定が未完了です（Secretsを設定してください）')
    }

    let telnyxResponse
    try {
      const res = await fetch('https://api.telnyx.com/v2/faxes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connection_id: connectionId,
          from: fromNumber,
          to: toE164,
          media_url: signedUrl,
          store_media: false,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(
          'Telnyx API エラー: ' + (json.errors?.[0]?.detail || JSON.stringify(json))
        )
      }
      telnyxResponse = json.data
    } catch (e) {
      // エラーログを記録
      await db.collection('faxLogs').add({
        senderUid: request.auth.uid,
        senderEmail: callerDoc.data().email || '',
        toNumber: toE164,
        fileName: safeName,
        projectId: projectId || null,
        docType: docType || null,
        companyKey: companyKey || null,
        status: 'failed',
        error: e.message,
        createdAt: new Date(),
      })
      throw new HttpsError('internal', 'FAX送信失敗: ' + e.message)
    }

    // 3. 送信ログをFirestoreに記録
    const logRef = await db.collection('faxLogs').add({
      senderUid: request.auth.uid,
      senderEmail: callerDoc.data().email || '',
      toNumber: toE164,
      toNumberOriginal: toNumber,
      fromNumber,
      fileName: safeName,
      pdfPath: path,
      projectId: projectId || null,
      docType: docType || null,
      companyKey: companyKey || null,
      telnyxFaxId: telnyxResponse.id,
      status: telnyxResponse.status || 'queued',
      createdAt: new Date(),
    })

    return {
      success: true,
      faxId: telnyxResponse.id,
      status: telnyxResponse.status,
      logId: logRef.id,
    }
  }
)

// Telnyx からの Webhook を受け取り、送信結果をログに反映
const { onRequest } = require('firebase-functions/v2/https')
const telnyxWebhook = onRequest(
  { region: 'asia-northeast1', cors: false },
  async (req, res) => {
    try {
      const event = req.body?.data
      if (!event || !event.event_type) {
        res.status(200).send('ok')
        return
      }

      const faxId = event.payload?.fax_id || event.payload?.id
      const status = event.payload?.status
      if (!faxId) {
        res.status(200).send('no-fax-id')
        return
      }

      const db = getFirestore()
      const snap = await db.collection('faxLogs').where('telnyxFaxId', '==', faxId).limit(1).get()
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: status || event.event_type,
          webhookEvent: event.event_type,
          webhookAt: new Date(),
          ...(event.payload?.failure_reason && { failureReason: event.payload.failure_reason }),
        })
      }
      res.status(200).send('ok')
    } catch (e) {
      console.error('Telnyx Webhook error:', e)
      res.status(500).send('error')
    }
  }
)

module.exports = { sendFax, telnyxWebhook }
