const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore } = require('firebase-admin/firestore')

initializeApp()

// Bカート在庫同期機能
const { syncBcartInventory } = require('./bcartSync')
exports.syncBcartInventory = syncBcartInventory

// 帳票メール送信
const { sendProjectDoc } = require('./sendProjectDoc')
exports.sendProjectDoc = sendProjectDoc

// メルマガ配信
const { sendNewsletter, nlTrack } = require('./sendNewsletter')
exports.sendNewsletter = sendNewsletter
exports.nlTrack = nlTrack

// 清算書通知メール
const { notifyKickback } = require('./notifyKickback')
exports.notifyKickback = notifyKickback

// Telnyx FAX送信
const { sendFax, telnyxWebhook } = require('./sendFax')
exports.sendFax = sendFax
exports.telnyxWebhook = telnyxWebhook

// Firestore 日次バックアップ
const { scheduledFirestoreBackup, cleanupOldBackups } = require('./firestoreBackup')
exports.scheduledFirestoreBackup = scheduledFirestoreBackup
exports.cleanupOldBackups = cleanupOldBackups

// Phase 2 段階1: 月次自動作成（重複作成防止機構）
// 設計書: docs/05_PHASE2_AUTOMATION.md §1
// 有効化は settings/settlement_automation.enabled = true の設定が必須。
// 初期配備は enabled=false のため呼び出しても aborted で戻る。
const {
  createMonthlySettlement,
  createMonthlySettlementScheduled,
} = require('./createMonthlySettlement')
exports.createMonthlySettlement = createMonthlySettlement
exports.createMonthlySettlementScheduled = createMonthlySettlementScheduled

// Phase 2 段階1: 二重作成検知（日次保険 + post_batch 即検知）
// 段階1 では structured docId 同士の衝突のみ検知対象。
// 既存の addDoc 自動採番データは検知対象から除外される。
const {
  detectDuplicates,
  detectDuplicatesScheduled,
} = require('./detectDuplicates')
exports.detectDuplicates = detectDuplicates
exports.detectDuplicatesScheduled = detectDuplicatesScheduled

/**
 * 管理者がFirebase Authユーザーを削除する
 * クライアントからは他人のAuthアカウントを削除できないため、
 * Admin SDKを使ったCloud Functionが必要
 */
exports.deleteAuthUser = onCall({ region: 'asia-northeast1' }, async (request) => {
  // 呼び出し元の認証チェック
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です')
  }

  // 管理者権限チェック（Firestoreのusersドキュメントで確認）
  const db = getFirestore()
  const callerDoc = await db.collection('users').doc(request.auth.uid).get()
  if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
    throw new HttpsError('permission-denied', '管理者権限が必要です')
  }

  const { email } = request.data
  if (!email) {
    throw new HttpsError('invalid-argument', 'メールアドレスが必要です')
  }

  try {
    // メールアドレスからユーザーを検索
    const userRecord = await getAuth().getUserByEmail(email)
    // Firebase Auth からユーザーを削除
    await getAuth().deleteUser(userRecord.uid)

    // Firestore の users ドキュメントも削除
    await db.collection('users').doc(userRecord.uid).delete()

    return { success: true, uid: userRecord.uid }
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      // Authにユーザーがなくても成功扱い（Firestoreだけ残ってた場合）
      return { success: true, message: 'Auth上にユーザーが見つかりませんでした' }
    }
    throw new HttpsError('internal', 'ユーザー削除に失敗: ' + error.message)
  }
})

/**
 * メールアドレスからFirebase AuthのUIDを取得する
 * アカウント再作成時に既存のAuthユーザーを再利用するため
 */
exports.getAuthUidByEmail = onCall({ region: 'asia-northeast1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です')
  }

  const db = getFirestore()
  const callerDoc = await db.collection('users').doc(request.auth.uid).get()
  if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
    throw new HttpsError('permission-denied', '管理者権限が必要です')
  }

  const { email } = request.data
  if (!email) {
    throw new HttpsError('invalid-argument', 'メールアドレスが必要です')
  }

  try {
    const userRecord = await getAuth().getUserByEmail(email)
    return { exists: true, uid: userRecord.uid }
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return { exists: false }
    }
    throw new HttpsError('internal', 'ユーザー検索に失敗: ' + error.message)
  }
})

/**
 * 代理店に成り代わってログイン（読み取り専用）
 * 管理者のみ実行可能。代理店のUIDでカスタムトークンを発行
 */
exports.impersonateDealer = onCall({ region: 'asia-northeast1' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です')
  }

  const db = getFirestore()
  const callerDoc = await db.collection('users').doc(request.auth.uid).get()
  if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
    throw new HttpsError('permission-denied', '管理者権限が必要です')
  }

  const { dealerEmail } = request.data
  if (!dealerEmail) {
    throw new HttpsError('invalid-argument', 'dealerEmail が必要です')
  }

  // 代理店のUIDを取得
  let dealerUser
  try {
    dealerUser = await getAuth().getUserByEmail(dealerEmail)
  } catch (e) {
    throw new HttpsError('not-found', '代理店アカウントが見つかりません: ' + dealerEmail)
  }

  // 対象が本当に代理店か確認
  const dealerDoc = await db.collection('users').doc(dealerUser.uid).get()
  if (!dealerDoc.exists || dealerDoc.data().role !== 'dealer') {
    throw new HttpsError('failed-precondition', '対象は代理店アカウントではありません')
  }

  // 監査ログ記録
  await db.collection('impersonationLogs').add({
    adminUid: request.auth.uid,
    adminEmail: callerDoc.data().email || '',
    targetUid: dealerUser.uid,
    targetEmail: dealerEmail,
    targetCompany: dealerDoc.data().companyName || '',
    mode: 'readonly',
    timestamp: new Date(),
  })

  // カスタムトークン発行（impersonating claim付き）
  const customToken = await getAuth().createCustomToken(dealerUser.uid, {
    impersonating: true,
    originalAdminUid: request.auth.uid,
    originalAdminEmail: callerDoc.data().email || '',
  })

  return { token: customToken }
})

/**
 * BカートAPI プロキシ
 * CORS問題を回避し、APIトークンをサーバー側で管理
 * フロントエンドからは /bcartProxy?endpoint=orders&limit=100 のように呼ぶ
 */
exports.bcartProxy = onRequest(
  { region: 'asia-northeast1', cors: true },
  async (req, res) => {
    // 認証チェック（Authorizationヘッダーからトークン検証）
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: '認証が必要です' })
      return
    }
    try {
      const idToken = authHeader.split('Bearer ')[1]
      await getAuth().verifyIdToken(idToken)
    } catch (e) {
      res.status(401).json({ error: '認証トークンが無効です' })
      return
    }

    // BカートAPIにリクエストを転送
    const { endpoint, ...params } = req.query
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint パラメータが必要です' })
      return
    }

    const url = new URL(`https://api.bcart.jp/api/v1/${endpoint}`)
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
    })

    try {
      const apiRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${process.env.BCART_API_TOKEN}` },
      })
      const data = await apiRes.json()
      res.status(apiRes.status).json(data)
    } catch (e) {
      res.status(500).json({ error: 'BカートAPI通信エラー: ' + e.message })
    }
  }
)
// ================================
// 受注メール速報（Webhook）
// ================================
exports.handleOrderEmail = onRequest(
  { region: 'asia-northeast1', cors: true },
  async (req, res) => {
    try {
      const db = getFirestore()

      const text = req.body?.text || ''

      if (!text) {
        res.status(400).send('No email body')
        return
      }

      const get = (regex) => {
        const m = text.match(regex)
        return m ? m[1].trim() : null
      }

      const orderId = get(/注文番号：(\d+)/)
      const orderDate = get(/注文日時：([\d\- :]+)/)
      const amountRaw = get(/注文総額：([\d,]+)円/)
      const companyName = get(/会社名：(.+)/)
      const customerName = get(/担当者：(.+?) 様/)

      const amount = amountRaw
        ? parseInt(amountRaw.replace(/,/g, ''), 10)
        : null

      if (!orderId) {
        res.status(400).send('Invalid format')
        return
      }

      const ref = db.collection('orderAlerts').doc(orderId)
      const exists = await ref.get()

      if (exists.exists) {
        res.status(200).send('Already exists')
        return
      }

      await ref.set({
        orderId,
        orderDate,
        companyName,
        customerName,
        amount,
        source: 'email',
        status: 'pending',
        dealerCode: null,
        createdAt: new Date(),
      })

      res.status(200).send('OK')
    } catch (e) {
      console.error(e)
      res.status(500).send('ERROR')
    }
  }
)