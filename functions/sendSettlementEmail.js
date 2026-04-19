// functions/sendSettlementEmail.js
// 清算書メール手動送信（admin限定・1帳票1ログで二重送信防止）
//
// 送信プロバイダ: SendGrid（2026-04-19 に SES から切り替え）
//
// 設計要点:
// 1. settlementEmailLogs/{kickbackId} を docId 固定にして「同一清算書=同一ログ」とする
// 2. Firestore transaction で create-only の pending を書く → 同時実行で衝突したら片方だけ通る
// 3. 既存 log が status='sent' なら always reject（二重送信禁止）
// 4. 既存 log が status='pending' なら reject（送信中衝突）
// 5. 既存 log が status='failed' の場合のみ上書きで再試行を許可
// 6. SendGrid 送信後に transaction 外で status を sent / failed に確定する
//
// 互換メモ:
//   settlementEmailLogs.sesMessageId フィールドは SES 時代の名前のまま残している。
//   SendGrid の messageId（x-message-id ヘッダー）をここに入れる。既存ログとの
//   互換性のためフィールド名は変えない。

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const sgMail = require('@sendgrid/mail')

// testDealerCode の優先順位（single source of truth は Firestore）
//
//   Single Source of Truth:
//     Firestore `settings/rt_company.testDealerCode`
//     → seed-test-dealer.mjs がここを更新する。通常運用ではこれだけを見る。
//
//   優先順位（Functions 側）:
//     1. process.env.TEST_DEALER_CODE   … デバッグ/緊急オーバーライド用
//     2. Firestore settings/rt_company.testDealerCode   … SSoT（通常はこちら）
//
//   env を 1 番優先にしている理由:
//     - Firestore 障害時に env で暫定稼働できる
//     - env が未設定なら確実に SSoT の Firestore 値を使うので二重管理は起きない
//     - env と Firestore が食い違った場合は env が勝つ（明示的な意思表示として扱う）
//
//   フロント側 (src/pages/KickbackManage.jsx):
//     同じ優先順位で VITE_TEST_DEALER_CODE → Firestore の順に参照する。
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
    const { kickbackId, testEmail, cc: ccOverride, bcc: bccOverride } = request.data || {}
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
    // 検証フェーズ用: kickback.isTest=true の清算書は件名・本文にテスト送信の明記を入れる
    // 実データの清算書（isTest=false/undefined）はこのフラグが立たないため影響しない
    const isTestSend = kickback.isTest === true

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

    // --- CC/BCC の決定 ---
    // 方針:
    //   - テスト送信（isTestSend=true）のとき:
    //       明示された request.cc / request.bcc を優先、
    //       無ければ settings/rt_company.settlementTestCc / settlementTestBcc をフォールバック
    //       基本は BCC（代理店に社内アドレスを見せない）
    //   - 実データ送信（isTestSend=false）のとき:
    //       request 明示のみ尊重し、settings からの自動付与は行わない
    //       （不意の社内アドレス混入を防ぐため）
    const normalizeEmails = (input) => {
      if (!input) return []
      const arr = Array.isArray(input) ? input : String(input).split(/[,;]+/)
      return arr
        .map((s) => String(s || '').trim())
        .filter((s) => s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
    }
    const rtSettingsDoc = await db.collection('settings').doc('rt_company').get()
    const rtSettings = rtSettingsDoc.exists ? rtSettingsDoc.data() : {}

    let ccList = normalizeEmails(ccOverride)
    let bccList = normalizeEmails(bccOverride)
    let ccSource = ccList.length > 0 ? 'request' : null
    let bccSource = bccList.length > 0 ? 'request' : null

    if (isTestSend) {
      if (ccList.length === 0 && rtSettings.settlementTestCc) {
        ccList = normalizeEmails(rtSettings.settlementTestCc)
        if (ccList.length > 0) ccSource = 'settings'
      }
      if (bccList.length === 0 && rtSettings.settlementTestBcc) {
        bccList = normalizeEmails(rtSettings.settlementTestBcc)
        if (bccList.length > 0) bccSource = 'settings'
      }
    }

    // To が CC/BCC に重複して入らないよう除外（二重送信を避ける）
    ccList = ccList.filter((e) => e !== toEmail)
    bccList = bccList.filter((e) => e !== toEmail && !ccList.includes(e))

    // --- 同月・同代理店で既に sent のログがあれば拒否（kickbacks の addDoc 由来の
    //     意味的重複をガードする。kickbacks の docId は自動採番のため、
    //     同じ dealerCode+month で別 ID の清算書が作られるケースに備える） ---
    if (dealerCode && month) {
      const dupSnap = await db.collection('settlementEmailLogs')
        .where('dealerCode', '==', dealerCode)
        .where('month', '==', month)
        .where('status', '==', 'sent')
        .get()
      const sentOther = dupSnap.docs.find((d) => d.id !== kickbackId)
      if (sentOther) {
        throw new HttpsError(
          'already-exists',
          `同月・同代理店で別の清算書が既に送信済みです（kickbackId: ${sentOther.id}、messageId: ${sentOther.data().sesMessageId || 'unknown'}）`,
        )
      }
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
      // 監査用: CC/BCC は件数とドメインのみ残す（完全アドレスは残さない）
      const domainOf = (email) => {
        const at = String(email).indexOf('@')
        return at > 0 ? String(email).slice(at).toLowerCase() : ''
      }
      tx.set(logRef, {
        kickbackId,
        dealerCode: dealerCode || '',
        dealerName: dealerName || '',
        month: month || '',
        status: 'pending',
        toEmail,
        ccCount: ccList.length,
        ccDomains: [...new Set(ccList.map(domainOf).filter(Boolean))],
        ccSource: ccSource || null, // 'request' | 'settings' | null
        bccCount: bccList.length,
        bccDomains: [...new Set(bccList.map(domainOf).filter(Boolean))],
        bccSource: bccSource || null,
        isTestSend, // 監査用: この送信がテスト送信扱いだったかどうか
        sentBy: request.auth.uid,
        sentByEmail: callerDoc.data().email || '',
        createdAt: snap.exists ? (snap.data().createdAt || now) : now,
        updatedAt: now,
        sesMessageId: null,
        errorMessage: null,
      })
    })

    // --- SendGrid 設定取得 ---
    // settings/rt_company.sendgridApiKey を SSoT とする。
    // 緊急オーバーライドとして env SENDGRID_API_KEY を用意。
    const settingsDoc = await db.collection('settings').doc('rt_company').get()
    const settings = settingsDoc.exists ? settingsDoc.data() : {}
    const sgApiKey = process.env.SENDGRID_API_KEY || settings.sendgridApiKey

    if (!sgApiKey) {
      await logRef.update({
        status: 'failed',
        errorMessage: 'SendGrid API キーが未設定です（settings/rt_company.sendgridApiKey）',
        updatedAt: FieldValue.serverTimestamp(),
      })
      throw new HttpsError('failed-precondition', 'SendGrid API キーが未設定です')
    }
    sgMail.setApiKey(sgApiKey)

    const senderName = settings.companyName || 'ロイヤルトラスト株式会社'
    const senderEmail = settings.sendgridFromEmail || settings.email || 'info@royaltrust.jp'

    const [y, m] = String(month || '').split('-')
    const monthLabel = y && m ? `${y}年${parseInt(m, 10)}月` : String(month || '')
    const amountLabel = grandTotal ? `¥${Number(grandTotal).toLocaleString()}` : ''

    const subjectPrefix = isTestSend ? '【テスト送信】' : ''
    const subject = `${subjectPrefix}【${senderName}】${monthLabel}分 清算書のご案内`
    const testHeader = isTestSend
      ? [
          '━━━━━━━━━━━━━━━━━━━━',
          '※ これはテスト送信です。',
          '  本番送信の検証目的で送っています。',
          '  金額・内容は仮のものです。実際の清算対象ではありません。',
          '  事前のご連絡の通り、内容の確認のみお願いいたします。',
          '━━━━━━━━━━━━━━━━━━━━',
          '',
        ]
      : []
    const textBody = [
      ...testHeader,
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

    // --- SendGrid 送信 ---
    // cc/bcc は SendGrid が MIME ヘッダ生成を担う。BCC は受信側に見えない（MIME の
    // Bcc ヘッダは SendGrid 側で削除される）。To/Cc/Bcc の重複は呼び出し前に除外済み。
    const msg = {
      to: toEmail,
      from: { email: senderEmail, name: senderName },
      subject,
      text: textBody,
    }
    if (ccList.length > 0) msg.cc = ccList
    if (bccList.length > 0) msg.bcc = bccList

    let sesMessageId // 互換フィールド名（SendGrid の x-message-id を入れる）
    try {
      const [response] = await sgMail.send(msg)
      // SendGrid の messageId は レスポンスヘッダの x-message-id に入る
      const headers = response && response.headers ? response.headers : {}
      sesMessageId = headers['x-message-id'] || null
    } catch (err) {
      // SendGrid のエラーはレスポンスボディに詳細が入る
      const detail = err && err.response && err.response.body
        ? JSON.stringify(err.response.body).slice(0, 800)
        : ''
      const errMsg = String(err && err.message ? err.message : err)
      console.error('SendGrid送信エラー:', errMsg, detail)
      await logRef.update({
        status: 'failed',
        errorMessage: (errMsg + (detail ? ' / ' + detail : '')).slice(0, 1000),
        updatedAt: FieldValue.serverTimestamp(),
      })
      throw new HttpsError('internal', 'メール送信に失敗しました: ' + errMsg)
    }

    // --- 成功確定（リトライ付き） ---
    // ここまで来たら SendGrid は実送信済み。
    // この update が失敗するとログは pending のまま残り、messageId も失われる。
    // そのため: (1) 3回リトライ (2) 最終的に失敗しても messageId をログに残す努力をする
    //         (3) 呼び出し元にも messageId を返す（管理画面から手動復旧可能にする）
    const finalUpdate = {
      status: 'sent',
      sesMessageId: sesMessageId,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    let updateErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await logRef.update(finalUpdate)
        updateErr = null
        break
      } catch (e) {
        updateErr = e
        console.error(`settlementEmailLogs update 失敗 (attempt ${attempt}/3):`, e)
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
    if (updateErr) {
      // 最終リトライでも失敗。実送信は成功しているので status は pending 残留になる。
      // せめて sesMessageId をサーバーログに残し、呼び出し元にも返す（admin が手動で status=sent に戻せる）。
      console.error(
        '[CRITICAL] SendGrid送信は成功したが Firestore 更新に失敗',
        { kickbackId, toEmail, sesMessageId, error: updateErr.message },
      )
      return {
        success: true,
        warning: 'SendGrid送信は完了しましたが、送信ログの status 更新に失敗しました。settlementEmailLogs を手動で sent に更新してください',
        kickbackId,
        toEmail,
        ccCount: ccList.length,
        bccCount: bccList.length,
        sesMessageId,
      }
    }

    return {
      success: true,
      kickbackId,
      toEmail,
      ccCount: ccList.length,
      bccCount: bccList.length,
      sesMessageId,
    }
  },
)

/**
 * pending 残留ログの手動解除（admin 限定）
 *
 * 用途:
 *   - transaction は通ったが SES 送信前に Functions が落ちて status='pending' のまま残留
 *   - SES 送信後の Firestore update が最終的に失敗して pending 残留
 *
 * 安全策:
 *   - admin 限定
 *   - 対象ログの createdAt から 5分以上経過している場合のみ許可（送信処理中の競合を避ける）
 *   - sesMessageId を明示指定できる場合は status='sent' で確定、無い場合は status='failed' に戻す
 *   - すべての解除操作を settlementEmailLogs に履歴として残す（resolvedBy / resolvedAt / resolvedReason）
 */
const resolveSettlementEmailLog = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'ログインが必要です')

    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    const { kickbackId, targetStatus, sesMessageId, reason } = request.data || {}
    if (!kickbackId || typeof kickbackId !== 'string') {
      throw new HttpsError('invalid-argument', 'kickbackId は必須です')
    }
    if (!['sent', 'failed'].includes(targetStatus)) {
      throw new HttpsError('invalid-argument', "targetStatus は 'sent' または 'failed' のみ")
    }
    if (!reason || typeof reason !== 'string') {
      throw new HttpsError('invalid-argument', 'reason（解除理由）は必須です')
    }
    if (targetStatus === 'sent' && !sesMessageId) {
      throw new HttpsError('invalid-argument', "targetStatus='sent' の場合 sesMessageId は必須")
    }

    const logRef = db.collection('settlementEmailLogs').doc(kickbackId)
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(logRef)
      if (!snap.exists) {
        throw new HttpsError('not-found', '対象ログが存在しません')
      }
      const cur = snap.data() || {}
      if (cur.status !== 'pending') {
        throw new HttpsError(
          'failed-precondition',
          `status='pending' のログのみ解除可能です（現在: ${cur.status}）`,
        )
      }
      // 5分経過チェック（送信処理中との競合防止）
      const createdAt = cur.createdAt?.toMillis?.() || 0
      if (createdAt && Date.now() - createdAt < 5 * 60 * 1000) {
        throw new HttpsError(
          'failed-precondition',
          '作成から5分経過していないため解除できません（送信処理と競合する恐れ）',
        )
      }

      const update = {
        status: targetStatus,
        updatedAt: FieldValue.serverTimestamp(),
        resolvedBy: request.auth.uid,
        resolvedByEmail: callerDoc.data().email || '',
        resolvedAt: FieldValue.serverTimestamp(),
        resolvedReason: String(reason).slice(0, 500),
      }
      if (targetStatus === 'sent') {
        update.sesMessageId = String(sesMessageId)
        update.sentAt = cur.sentAt || FieldValue.serverTimestamp()
      } else {
        update.errorMessage =
          'pending 残留を admin が手動解除: ' + String(reason).slice(0, 400)
      }
      tx.update(logRef, update)
    })

    return { success: true, kickbackId, targetStatus }
  },
)

module.exports = { sendSettlementEmail, resolveSettlementEmailLog }
