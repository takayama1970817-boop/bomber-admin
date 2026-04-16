// functions/sendNewsletter.js
// メルマガ一括配信 Cloud Function（開封/クリック計測付き）

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onRequest } = require('firebase-functions/v2/https')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses')

/**
 * メルマガ一括送信
 * @param {string} data.newsletterId - メルマガドキュメントID
 * @param {string} [data.testEmail] - テスト送信先（指定時は1通のみ送信）
 */
const sendNewsletter = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ログインが必要です')

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    const { newsletterId, testEmail } = request.data
    if (!newsletterId) throw new HttpsError('invalid-argument', 'newsletterId は必須です')

    // メルマガデータ取得
    const nlDoc = await db.collection('newsletters').doc(newsletterId).get()
    if (!nlDoc.exists) throw new HttpsError('not-found', 'メルマガが見つかりません')
    const nl = nlDoc.data()

    // SES設定取得
    const settingsDoc = await db.collection('settings').doc('rt_company').get()
    const settings = settingsDoc.exists ? settingsDoc.data() : {}
    const sesRegion = settings.sesRegion || process.env.SES_REGION || 'ap-northeast-1'
    const sesAccessKey = settings.sesAccessKeyId || process.env.SES_ACCESS_KEY_ID
    const sesSecretKey = settings.sesSecretAccessKey || process.env.SES_SECRET_ACCESS_KEY

    if (!sesAccessKey || !sesSecretKey) {
      throw new HttpsError('failed-precondition', 'SES設定が未設定です')
    }

    const sesClient = new SESClient({
      region: sesRegion,
      credentials: { accessKeyId: sesAccessKey, secretAccessKey: sesSecretKey },
    })

    const senderName = nl.fromName || settings.companyName || 'VAVITTE'
    const senderEmail = settings.email || 'info@royaltrust.jp'

    // 配信先取得
    let readers
    if (testEmail) {
      readers = [{ email: testEmail, name: 'テスト', company: 'テスト' }]
    } else {
      const readerSnap = await db.collection('nl_readers').where('status', '==', 'active').get()
      readers = readerSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

      // セグメントフィルタ
      if (nl.segment === 'salon') readers = readers.filter((r) => r.type === 'salon')
      else if (nl.segment === 'dealer') readers = readers.filter((r) => r.type === 'dealer')
    }

    if (readers.length === 0) {
      throw new HttpsError('failed-precondition', '配信先の読者がいません')
    }

    // トラッキングURL / 配信解除URL
    const trackBase = 'https://asia-northeast1-bomber-admin.cloudfunctions.net/nlTrack'
    const siteBase = 'https://bomber-admin.web.app'

    let sent = 0
    let failed = 0

    for (const reader of readers) {
      try {
        // 差し込み変数の置換
        let textBody = (nl.body || '').replace(/\{company\}/g, reader.company || '')
          .replace(/\{name\}/g, reader.name || '')
          .replace(/\{email\}/g, reader.email || '')

        let htmlBody = (nl.htmlBody || nl.body || '').replace(/\{company\}/g, reader.company || '')
          .replace(/\{name\}/g, reader.name || '')
          .replace(/\{email\}/g, reader.email || '')

        // ログドキュメント作成（トラッキング用）
        let logId = null
        if (!testEmail) {
          const logRef = await db.collection('nl_logs').add({
            newsletterId,
            readerId: reader.id || '',
            email: reader.email,
            status: 'sending',
            sentAt: FieldValue.serverTimestamp(),
          })
          logId = logRef.id
        }

        // HTML版に開封トラッキングピクセルとクリック計測を追加
        if (nl.format === 'html' && logId) {
          const openPixel = `<img src="${trackBase}?type=open&id=${logId}" width="1" height="1" style="display:none;" />`
          // リンクのクリック計測（<a href="..."> を置換）
          htmlBody = htmlBody.replace(
            /href="(https?:\/\/[^"]+)"/g,
            (match, url) => `href="${trackBase}?type=click&id=${logId}&url=${encodeURIComponent(url)}"`
          )
          htmlBody += openPixel
        }

        // 配信解除リンク（特定電子メール法対応）
        const unsubUrl = `${siteBase}/newsletter/unsubscribe?email=${encodeURIComponent(reader.email)}`
        const unsubText = `\n\n---\n配信停止はこちら: ${unsubUrl}`
        const unsubHtml = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;font-size:11px;color:#999;">配信停止をご希望の方は<a href="${unsubUrl}" style="color:#666;">こちら</a></div>`

        textBody += unsubText
        if (nl.format === 'html') htmlBody += unsubHtml

        // テキストメールでも最低限のHTMLラップ
        const finalHtml = nl.format === 'html'
          ? htmlBody
          : `<html><body style="font-family:sans-serif;font-size:14px;line-height:1.8;color:#333;white-space:pre-wrap;">${textBody}${logId ? `<img src="${trackBase}?type=open&id=${logId}" width="1" height="1" style="display:none;" />` : ''}</body></html>`

        // MIME構築
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const headers = [
          `From: =?UTF-8?B?${Buffer.from(senderName).toString('base64')}?= <${senderEmail}>`,
          `To: ${reader.email}`,
          `Subject: =?UTF-8?B?${Buffer.from(nl.subject).toString('base64')}?=`,
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          `List-Unsubscribe: <${unsubUrl}>`,
          `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
        ].join('\r\n')

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
          Buffer.from(finalHtml).toString('base64'),
        ].join('\r\n')

        const rawMessage = [headers, '', textPart, '', htmlPart, '', `--${boundary}--`].join('\r\n')

        await sesClient.send(new SendRawEmailCommand({
          Source: `${senderName} <${senderEmail}>`,
          Destinations: [reader.email],
          RawMessage: { Data: Buffer.from(rawMessage) },
        }))

        if (logId) {
          await db.collection('nl_logs').doc(logId).update({ status: 'sent' })
        }
        sent++

        // SESのレート制限対策（1秒14通制限の場合）
        if (sent % 10 === 0) await new Promise((r) => setTimeout(r, 1000))

      } catch (err) {
        console.error(`送信失敗 [${reader.email}]:`, err.message)
        failed++
      }
    }

    // メルマガの送信統計を更新
    if (!testEmail) {
      await db.collection('newsletters').doc(newsletterId).update({
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
        sentCount: sent,
        failedCount: failed,
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    return { sent, failed, total: readers.length }
  }
)

/**
 * トラッキングエンドポイント（開封/クリック計測）
 * ?type=open&id=LOG_ID → 開封記録、1x1透過GIF返却
 * ?type=click&id=LOG_ID&url=ENCODED_URL → クリック記録、リダイレクト
 */
const nlTrack = onRequest(
  { region: 'asia-northeast1', cors: true },
  async (req, res) => {
    const { type, id, url } = req.query

    if (!id) {
      res.status(400).send('missing id')
      return
    }

    const db = getFirestore()

    try {
      const logRef = db.collection('nl_logs').doc(id)
      const logDoc = await logRef.get()

      if (logDoc.exists) {
        if (type === 'open' && !logDoc.data().openedAt) {
          await logRef.update({ openedAt: FieldValue.serverTimestamp() })
          // メルマガの開封カウントも更新
          const nlId = logDoc.data().newsletterId
          if (nlId) {
            await db.collection('newsletters').doc(nlId).update({
              openCount: FieldValue.increment(1),
            })
          }
        } else if (type === 'click') {
          if (!logDoc.data().clickedAt) {
            await logRef.update({ clickedAt: FieldValue.serverTimestamp(), clickUrl: url || '' })
            const nlId = logDoc.data().newsletterId
            if (nlId) {
              await db.collection('newsletters').doc(nlId).update({
                clickCount: FieldValue.increment(1),
              })
            }
          }
        }
      }
    } catch (e) {
      console.error('トラッキングエラー:', e)
    }

    if (type === 'click' && url) {
      res.redirect(302, decodeURIComponent(url))
    } else {
      // 1x1 透過GIF
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
      res.set('Content-Type', 'image/gif')
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      res.send(gif)
    }
  }
)

module.exports = { sendNewsletter, nlTrack }
