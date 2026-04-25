// functions/sendFax.js
// InterFAX REST API 経由でFAX送信する Cloud Function
//
// 仕様（公式）:
//   POST https://rest.interfax.net/outbound/faxes?faxNumber=+81363329691
//     Authorization: Basic <base64(user:pass)>
//     Content-Type: application/pdf
//     Body: PDFバイナリ（JSON でも base64 でもない）
//   成功時: 201 Created  Location: /outbound/faxes/{id}
//
//   GET /outbound/faxes/{id} → 送信ステータス確認
//
// データモデル:
//   faxJobs/{jobId}      送信ジョブ（PDF storage パス + 最新状態。再送の単位）
//   faxLogs/{logId}      個別の送信試行ログ（jobId 紐付け、追記型）
//   Storage: fax-files/{jobId}.pdf  再送用 PDF を保存
//
// Callable functions:
//   sendFax({ pdfBase64, fileName, toNumber, purpose, subject, notes, projectId, docType, companyKey })
//   resendFax({ jobId, toNumber? })
//   checkFaxStatus({ faxId, logId, jobId })
//
// 必要な Firebase Secrets:
//   INTERFAX_USER / INTERFAX_PASS

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { defineSecret } = require('firebase-functions/params')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const logger = require('firebase-functions/logger')

const INTERFAX_USER = defineSecret('INTERFAX_USER')
const INTERFAX_PASS = defineSecret('INTERFAX_PASS')

const INTERFAX_BASE = 'https://rest.interfax.net'

const PURPOSE_LABELS = {
  shipping_instruction: '発送指示書',
  partner_contact: '取引先連絡',
  warehouse_contact: '倉庫向け連絡',
  business_doc: '業務帳票',
  project_doc: '案件帳票',
  other: 'その他',
}

function toE164Japan(number) {
  if (!number) return ''
  const n = String(number).replace(/[^\d+]/g, '')
  if (n.startsWith('+')) return n
  if (n.startsWith('0')) return '+81' + n.slice(1)
  return '+81' + n
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

// InterFAX status コード判定
//   0 = 完了 / 負 = 送信中 / 正 = 失敗
function mapInterfaxStatus(code) {
  if (code == null) return 'unknown'
  if (code === 0) return 'completed'
  if (code < 0) return 'in_progress'
  return 'failed'
}

async function assertInternalCaller(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'ログインが必要です')
  }
  const db = getFirestore()
  const snap = await db.collection('users').doc(request.auth.uid).get()
  const role = snap.exists ? snap.data().role : null
  if (!['admin', 'master', 'staff'].includes(role)) {
    throw new HttpsError('permission-denied', '社内スタッフのみ実行できます')
  }
  return { db, callerSnap: snap, callerRole: role }
}

async function postPdfToInterfax({ pdfBuffer, faxNumber, user, pass }) {
  const url = `${INTERFAX_BASE}/outbound/faxes?faxNumber=${encodeURIComponent(faxNumber)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(user, pass),
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdfBuffer.length),
    },
    body: pdfBuffer,
  })
  const responseHeaders = Object.fromEntries(res.headers.entries())
  const responseText = await res.text()
  return { res, responseHeaders, responseText }
}

const sendFax = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [INTERFAX_USER, INTERFAX_PASS],
  },
  async (request) => {
    const { db, callerSnap } = await assertInternalCaller(request)
    const callerEmail = callerSnap.data()?.email || ''

    const {
      pdfBase64,
      fileName,
      toNumber,
      purpose,
      subject,
      notes,
      projectId,
      docType,
      companyKey,
    } = request.data || {}

    if (!pdfBase64 || !toNumber) {
      throw new HttpsError('invalid-argument', 'PDFと送信先は必須です')
    }

    const faxNumber = toE164Japan(toNumber)
    if (!/^\+\d{10,15}$/.test(faxNumber)) {
      throw new HttpsError('invalid-argument', '送信先FAX番号が不正です: ' + toNumber)
    }

    const user = INTERFAX_USER.value()
    const pass = INTERFAX_PASS.value()
    if (!user || !pass) {
      throw new HttpsError(
        'failed-precondition',
        'InterFAX認証情報が未設定です（INTERFAX_USER / INTERFAX_PASS）'
      )
    }

    const pdfBuffer = Buffer.from(pdfBase64, 'base64')
    const safeName = (fileName || 'fax.pdf').replace(/[^\w.\-]/g, '_')
    const purposeKey = PURPOSE_LABELS[purpose] ? purpose : 'other'

    const jobRef = db.collection('faxJobs').doc()
    const jobId = jobRef.id
    const pdfPath = `fax-files/${jobId}.pdf`

    const bucket = getStorage().bucket()
    await bucket.file(pdfPath).save(pdfBuffer, {
      contentType: 'application/pdf',
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600' },
    })

    await jobRef.set({
      createdBy: request.auth.uid,
      createdByEmail: callerEmail,
      toNumber: faxNumber,
      toNumberOriginal: toNumber,
      fileName: safeName,
      pdfPath,
      pdfSize: pdfBuffer.length,
      purpose: purposeKey,
      purposeLabel: PURPOSE_LABELS[purposeKey],
      subject: subject || '',
      notes: notes || '',
      projectId: projectId || null,
      docType: docType || null,
      companyKey: companyKey || null,
      status: 'queued',
      attemptCount: 0,
      lastFaxId: null,
      lastError: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return executeFaxAttempt({
      db,
      jobRef,
      jobId,
      pdfBuffer,
      faxNumber,
      safeName,
      user,
      pass,
      senderUid: request.auth.uid,
      senderEmail: callerEmail,
    })
  }
)

const resendFax = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [INTERFAX_USER, INTERFAX_PASS],
  },
  async (request) => {
    const { db, callerSnap } = await assertInternalCaller(request)
    const callerEmail = callerSnap.data()?.email || ''

    const { jobId, toNumber: overrideTo } = request.data || {}
    if (!jobId) throw new HttpsError('invalid-argument', 'jobId が必要です')

    const jobRef = db.collection('faxJobs').doc(jobId)
    const jobSnap = await jobRef.get()
    if (!jobSnap.exists) throw new HttpsError('not-found', '送信ジョブが見つかりません')
    const job = jobSnap.data()

    const faxNumber = overrideTo ? toE164Japan(overrideTo) : job.toNumber
    if (!/^\+\d{10,15}$/.test(faxNumber)) {
      throw new HttpsError('invalid-argument', '送信先FAX番号が不正です: ' + faxNumber)
    }

    const user = INTERFAX_USER.value()
    const pass = INTERFAX_PASS.value()
    if (!user || !pass) {
      throw new HttpsError('failed-precondition', 'InterFAX認証情報が未設定です')
    }

    const bucket = getStorage().bucket()
    const [exists] = await bucket.file(job.pdfPath).exists()
    if (!exists) {
      throw new HttpsError('failed-precondition', '元PDFが Storage 上に見つかりません: ' + job.pdfPath)
    }
    const [pdfBuffer] = await bucket.file(job.pdfPath).download()

    if (faxNumber !== job.toNumber) {
      await jobRef.update({
        toNumber: faxNumber,
        toNumberOriginal: overrideTo || job.toNumberOriginal,
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    return executeFaxAttempt({
      db,
      jobRef,
      jobId,
      pdfBuffer,
      faxNumber,
      safeName: job.fileName,
      user,
      pass,
      senderUid: request.auth.uid,
      senderEmail: callerEmail,
      isResend: true,
    })
  }
)

async function executeFaxAttempt({
  db, jobRef, jobId, pdfBuffer, faxNumber, safeName, user, pass,
  senderUid, senderEmail, isResend = false,
}) {
  const attemptNo = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef)
    const cur = snap.exists ? (snap.data().attemptCount || 0) : 0
    const next = cur + 1
    tx.update(jobRef, {
      attemptCount: next,
      status: 'queued',
      lastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    })
    return next
  })

  const logRef = db.collection('faxLogs').doc()

  try {
    const { res, responseHeaders, responseText } = await postPdfToInterfax({
      pdfBuffer, faxNumber, user, pass,
    })

    if (!res.ok) {
      logger.error('InterFAX 送信失敗', {
        jobId, attemptNo,
        httpStatus: res.status, statusText: res.statusText,
        headers: responseHeaders, body: responseText,
        faxNumber, fileName: safeName, pdfSize: pdfBuffer.length,
      })

      await logRef.set({
        jobId, attemptNo,
        senderUid, senderEmail,
        provider: 'interfax',
        toNumber: faxNumber,
        fileName: safeName,
        pdfSize: pdfBuffer.length,
        status: 'failed',
        httpStatus: res.status,
        responseBody: responseText.slice(0, 4000),
        responseHeaders,
        error: `InterFAX HTTP ${res.status}`,
        isResend,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })

      await jobRef.update({
        status: 'failed',
        lastError: `InterFAX HTTP ${res.status}: ${responseText.slice(0, 300)}`,
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })

      throw new HttpsError(
        'internal',
        `InterFAX 送信失敗 (HTTP ${res.status}): ${responseText.slice(0, 200)}`
      )
    }

    const location = res.headers.get('location') || ''
    const m = location.match(/\/outbound\/faxes\/(\d+)/)
    const faxId = m ? m[1] : null

    if (!faxId) {
      logger.error('InterFAX Location ヘッダー解析失敗', {
        jobId, attemptNo, location, headers: responseHeaders, body: responseText,
      })
      await logRef.set({
        jobId, attemptNo,
        senderUid, senderEmail,
        provider: 'interfax',
        toNumber: faxNumber, fileName: safeName, pdfSize: pdfBuffer.length,
        status: 'failed',
        httpStatus: res.status,
        responseHeaders, responseBody: responseText.slice(0, 4000),
        error: 'Location ヘッダー解析失敗: ' + location,
        isResend,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      await jobRef.update({
        status: 'failed',
        lastError: 'fax id 取得失敗',
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      throw new HttpsError('internal', 'InterFAX 応答から fax id を取得できません')
    }

    await logRef.set({
      jobId, attemptNo,
      senderUid, senderEmail,
      provider: 'interfax',
      toNumber: faxNumber, fileName: safeName, pdfSize: pdfBuffer.length,
      interfaxFaxId: faxId, interfaxLocation: location,
      status: 'queued',
      httpStatus: res.status,
      isResend,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    await jobRef.update({
      status: 'queued',
      lastFaxId: faxId,
      lastLogId: logRef.id,
      lastAttemptAt: FieldValue.serverTimestamp(),
      lastError: null,
      updatedAt: FieldValue.serverTimestamp(),
    })

    logger.info('InterFAX 送信受付', {
      jobId, attemptNo, faxId, faxNumber, fileName: safeName, logId: logRef.id,
    })

    return {
      success: true,
      jobId, faxId, logId: logRef.id, attemptNo,
      status: 'queued',
      location,
      statusCheckPath: `/outbound/faxes/${faxId}`,
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e
    logger.error('InterFAX 送信例外', {
      jobId, attemptNo, error: e.message, stack: e.stack, faxNumber, fileName: safeName,
    })
    await logRef.set({
      jobId, attemptNo,
      senderUid, senderEmail,
      provider: 'interfax',
      toNumber: faxNumber, fileName: safeName, pdfSize: pdfBuffer.length,
      status: 'failed',
      error: e.message,
      isResend,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    await jobRef.update({
      status: 'failed',
      lastError: e.message,
      lastAttemptAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    throw new HttpsError('internal', 'FAX送信失敗: ' + e.message)
  }
}

const checkFaxStatus = onCall(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 30,
    secrets: [INTERFAX_USER, INTERFAX_PASS],
  },
  async (request) => {
    const { db } = await assertInternalCaller(request)

    const { faxId, logId, jobId } = request.data || {}
    if (!faxId) throw new HttpsError('invalid-argument', 'faxId が必要です')

    const user = INTERFAX_USER.value()
    const pass = INTERFAX_PASS.value()

    const url = `${INTERFAX_BASE}/outbound/faxes/${encodeURIComponent(faxId)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(user, pass),
        Accept: 'application/json',
      },
    })

    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text } }

    if (!res.ok) {
      logger.error('InterFAX ステータス取得失敗', {
        httpStatus: res.status, body: text, faxId,
      })
      throw new HttpsError(
        'internal',
        `ステータス取得失敗 (HTTP ${res.status}): ${text.slice(0, 200)}`
      )
    }

    const mapped = mapInterfaxStatus(data.status)
    const patch = {
      status: mapped,
      interfaxStatus: data.status ?? null,
      interfaxStatusString: data.statusString || null,
      completionTime: data.completionTime || null,
      pagesSent: data.pagesSent ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    }

    if (logId) {
      try { await db.collection('faxLogs').doc(logId).update(patch) }
      catch (e) { logger.warn('faxLogs 更新失敗', { logId, error: e.message }) }
    }
    if (jobId) {
      try {
        await db.collection('faxJobs').doc(jobId).update({
          status: mapped,
          updatedAt: FieldValue.serverTimestamp(),
        })
      } catch (e) {
        logger.warn('faxJobs 更新失敗', { jobId, error: e.message })
      }
    }

    return { success: true, faxId, status: mapped, data }
  }
)

module.exports = { sendFax, resendFax, checkFaxStatus }
