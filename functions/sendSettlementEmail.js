// functions/sendSettlementEmail.js
// 清算書メール手動送信（admin限定・1帳票1ログで二重送信防止）
//
// 設計要点:
// 1. settlementEmailLogs/{kickbackId} を docId 固定にして「同一清算書=同一ログ」とする
// 2. Firestore transaction で create-only の pending を書く → 同時実行で衝突したら片方だけ通る
// 3. 既存 log が status='sent' なら always reject（二重送信禁止）
// 4. 既存 log が status='pending' なら reject（送信中衝突）
// 5. 既存 log が status='failed' の場合のみ上書きで再試行を許可
// 6. SES 送信後に transaction 外で status を sent / failed に確定する

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses')

// 環境変数 or Firestore settings から「送信許可された代理店コード」を取得
// 今日のスコープではテスト代理店1件のみに絞る
async function getAllowedTestDealerCode(db) {
  const fromEnv = process.env.TEST_DEALER_CODE
  if (fromEnv) return String(fromEnv).trim()
  const doc = await db.collection('settings').doc('rt_company').get()
  const val = doc.exists ? doc.data().testDealerCode : ''
  return val ? String(val).trim() : ''
}

const sendSettlementEmail = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    // --- 認証 & admin チェック ---
    if (!request.auth) throw new HttpsError('unauthenticated', 'ログインが必要です')

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    // --- 入力 ---
    const { kickbackId, testEmail } = request.data || {}
    if (!kickbackId || typeof kickbackId !== 'string') {
      throw new HttpsError('invalid-argument', 'kickbackId は必須です')
    }

    // --- kickback 取得 ---
    const kickbackRef = db.collection('kickbacks').doc(kickbackId)
    const kickbackSnap = await kickbackRef.get()
    if (!kickbackSnap.exists) {
      throw new HttpsError('not-found', `清算書が存在しません: ${kickbackId}`)
    }
    const kickback = kickbackSnap.data()
    const { dealerCode, dealerName, month, grandTotal } = kickback

    // --- 今日のスコープ: テスト代理店1件のみ許可 ---
    const allowedDealerCode = await getAllowedTestDealerCode(db)
    if (!allowedDealerCode) {
      throw new HttpsError(
        'failed-precondition',
        'テスト代理店コードが未設定です（TEST_DEALER_CODE または settings/rt_company.testDealerCode）',
      )
    }
    if (String(dealerCode) !== allowedDealerCode) {
      throw new HttpsError(
        'permission-denied',
        `今日の手動送信は ${allowedDealerCode} のみ許可されています（対象: ${dealerCode}）`,
      )
    }

    // --- 宛先メール決定 ---
    let toEmail = testEmail && String(testEmail).trim()
    if (!toEmail) {
      const emailSnap = await db.collection('allowedEmails')
        .where('dealerCode', '==', dealerCode)
        .where('role', '==', 'dealer')
        .get()
      if (emailSnap.empty) {
        throw new HttpsError('not-found', `代理店 ${dealerCode} のメールアドレスが登録されていません`)
      }
      toEmail = emailSnap.docs[0].data().email || emailSnap.docs[0].id
    }
    if (!toEmail) {
      throw new HttpsError('failed-precondition', '宛先メールアドレスを決定できません')
    }

    // --- 送信ログ: transaction で create-only pending ---
    // docId を kickbackId に固定することで、同一清算書に対するログは必ず1件
    const logRef = db.collection('settlementEmailLogs').doc(kickbackId)
    const now = FieldValue.serverTimestamp()

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(logRef)
      if (snap.exists) {
        const prev = snap.data() || {}
        if (prev.status === 'sent') {
          throw new HttpsError(
            'already-exists',
            `この清算書は既に送信済みです (messageId: ${prev.sesMessageId || 'unknown'})`,
          )
        }
        if (prev.status === 'pending') {
          throw new HttpsError(
            'already-exists',
            '送信処理中です。完了または失敗までお待ちください',
          )
        }
        // status === 'failed' のみ再試行許可（pending で上書き）
      }
      tx.set(logRef, {
        kickbackId,
        dealerCode: dealerCode || '',
        dealerName: dealerName || '',
        month: month || '',
        status: 'pending',
        toEmail,
        sentBy: request.auth.uid,
        sentByEmail: callerDoc.data().email || '',
        createdAt: snap.exists ? (snap.data().createdAt || now) : now,
        updatedAt: now,
        sesMessageId: null,
        errorMessage: null,
      })
    })

    // --- SES 設定取得 ---
    const settingsDoc = await db.collection('settings').doc('rt_company').get()
    const settings = settingsDoc.exists ? settingsDoc.data() : {}
    const sesRegion = settings.sesRegion || 'ap-northeast-1'
    const sesAccessKey = settings.sesAccessKeyId
    const sesSecretKey = settings.sesSecretAccessKey

    if (!sesAccessKey || !sesSecretKey) {
      await logRef.update({
        status: 'failed',
        errorMessage: 'SES設定が未設定です',
        updatedAt: FieldValue.serverTimestamp(),
      })
      throw new HttpsError('failed-precondition', 'SES設定が未設定です')
    }

    const sesClient = new SESClient({
      region: sesRegion,
      credentials: { accessKeyId: sesAccessKey, secretAccessKey: sesSecretKey },
    })

    const senderName = settings.companyName || 'ロイヤルトラスト株式会社'
    const senderEmail = settings.email || 'info@royaltrust.jp'

    const [y, m] = String(month || '').split('-')
    const monthLabel = y && m ? `${y}年${parseInt(m, 10)}月` : String(month || '')
    const amountLabel = grandTotal ? `¥${Number(grandTotal).toLocaleString()}` : ''

    const subject = `【${senderName}】${monthLabel}分 清算書のご案内`
    const textBody = [
      `${dealerName || dealerCode} 様`,
      '',
      'いつもお世話になっております。',
      `${senderName}です。`,
      '',
      `${monthLabel}分の清算書をご案内いたします。`,
      amountLabel ? `清算額（税込）: ${amountLabel}` : '',
      '',
      '詳細は代理店ポータルよりご確認ください。',
      'https://bomber-admin.web.app/dealer',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      senderName,
      settings.email ? `Email: ${settings.email}` : '',
      settings.tel ? `TEL: ${settings.tel}` : '',
      '━━━━━━━━━━━━━━━━━━━━',
    ].filter(Boolean).join('\r\n')

    // MIME 構築（本日のスコープ: PDF 添付なし・テキストのみ）
    const boundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const headers = [
      `From: =?UTF-8?B?${Buffer.from(senderName).toString('base64')}?= <${senderEmail}>`,
      `To: ${toEmail}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].join('\r\n')

    const textPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(textBody).toString('base64'),
    ].join('\r\n')

    const rawMessage = [headers, '', textPart, '', `--${boundary}--`].join('\r\n')

    // --- SES 送信 ---
    let sesMessageId
    try {
      const result = await sesClient.send(new SendRawEmailCommand({
        Source: `${senderName} <${senderEmail}>`,
        Destinations: [toEmail],
        RawMessage: { Data: Buffer.from(rawMessage) },
      }))
      sesMessageId = result.MessageId || null
    } catch (err) {
      console.error('SES送信エラー:', err)
      await logRef.update({
        status: 'failed',
        errorMessage: String(err && err.message ? err.message : err).slice(0, 1000),
        updatedAt: FieldValue.serverTimestamp(),
      })
      throw new HttpsError('internal', 'メール送信に失敗しました: ' + err.message)
    }

    // --- 成功確定 ---
    await logRef.update({
      status: 'sent',
      sesMessageId: sesMessageId,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return {
      success: true,
      kickbackId,
      toEmail,
      sesMessageId,
    }
  },
)

module.exports = { sendSettlementEmail }
