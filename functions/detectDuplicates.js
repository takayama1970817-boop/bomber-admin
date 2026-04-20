/**
 * detectDuplicates.js
 *
 * Phase 2 段階1 の二重作成検知。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §1.10, §3.5
 *
 * エクスポート:
 *   - detectDuplicates           : onCall（admin 手動トリガー）
 *   - detectDuplicatesScheduled  : onSchedule（毎日 01:00 JST）
 *   - runDetectDuplicates        : 内部関数（createMonthlySettlement post_batch 等）
 *
 * 段階1 の重要ポリシー（本線指示 Step C）:
 *   1. 検知対象は structured docId のみ（isStructuredSettlementDocId で判定）
 *      既存の addDoc 自動採番データは判定対象から除外する
 *      → 段階1 の 2 か月間、既存 UI（KickbackManage / InvoiceManage）で作られた
 *        データは意味的重複があっても本関数では検知しない
 *   2. 検知結果は settlementDuplicateChecks に append-only 書き込み
 *   3. 検知されたら settings/settlement_automation.enabled=false で即停止
 *      ただし既存混在で誤停止しないよう、structured docId 同士の衝突のみ停止条件とする
 *   4. onCall / onSchedule を分離。内部関数 runDetectDuplicates は再利用可能
 *
 * 検知ロジック:
 *   - kickbacks / invoices を走査
 *   - structured docId のみ取り出し
 *   - {dealerCode}|{month} で Map 集約
 *   - 同一キーに structured docId が 2 件以上あれば「二重作成」
 *   - 既存 addDoc docId は isStructuredSettlementDocId で除外（false を返す）
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')

const { isStructuredSettlementDocId } = require('./lib/settlementIdUtils')
const { disableAutomation } = require('./lib/settlementAutomation')
const { notifyAdmin } = require('./lib/notifyAdmin')

const REGION = 'asia-northeast1'
const TIMEOUT_SECONDS = 120
const MEMORY = '256MiB'
const SCRIPT_VERSION = '2026-04-20.phase2-1.v1'

const TRIGGERED_BY_ALLOWED = Object.freeze([
  'post_batch',       // createMonthlySettlement の末尾から呼ばれる
  'scheduled_daily',  // Cloud Scheduler 日次保険
  'manual',           // admin の onCall
])

// =====================================================================
// 検知ロジック（内部）
// =====================================================================

/**
 * 単一コレクションを走査して structured docId のみで意味的重複を検知する。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} collectionName - 'kickbacks' or 'invoices'
 * @returns {Promise<{
 *   scannedTotal: number,
 *   structuredCount: number,
 *   legacyCount: number,
 *   duplicates: Array<{collection:string, key:string, docIds:string[]}>,
 * }>}
 */
async function scanCollectionForDuplicates(db, collectionName) {
  const snap = await db.collection(collectionName).get()

  const seen = new Map() // key: "dealerCode|month", value: [docId, ...]
  let structuredCount = 0
  let legacyCount = 0

  for (const doc of snap.docs) {
    // 本線指示: structured docId のみ対象（既存 addDoc は除外）
    if (!isStructuredSettlementDocId(doc.id)) {
      legacyCount += 1
      continue
    }
    structuredCount += 1

    const data = doc.data() || {}
    const dealerCode = data.dealerCode
    const month = data.month
    if (!dealerCode || !month) continue

    const key = `${dealerCode}|${month}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(doc.id)
  }

  const duplicates = []
  for (const [key, ids] of seen) {
    if (ids.length > 1) {
      duplicates.push({ collection: collectionName, key, docIds: ids })
    }
  }

  return {
    scannedTotal: snap.size,
    structuredCount,
    legacyCount,
    duplicates,
  }
}

/**
 * settlementDuplicateChecks に検知結果を append する。
 * §3.5 スキーマ + v0.8 の kind フィールド。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} entry
 * @returns {Promise<string>} checkId
 */
async function writeDuplicateCheck(db, entry) {
  const ref = await db.collection('settlementDuplicateChecks').add({
    kind: 'creation', // §3.5 v0.8: 作成系 / 送信系の区別。本関数は作成系のみ
    runAt: FieldValue.serverTimestamp(),
    triggeredBy: entry.triggeredBy,
    targetMonth: entry.targetMonth || null,
    checkedCollections: entry.checkedCollections,

    // 集計
    scannedTotal: entry.scannedTotal,
    structuredCount: entry.structuredCount,
    legacyCount: entry.legacyCount,
    duplicatesFound: entry.duplicates.length,
    duplicates: entry.duplicates,

    // メタ
    scriptVersion: SCRIPT_VERSION,
  })
  return ref.id
}

/**
 * 重複検知時の即停止アクション。
 * settings/settlement_automation.enabled=false + notifyAdmin(critical)。
 *
 * 注意: 段階1 では structured docId 同士の衝突のみ停止対象とするため、
 *       本関数が呼ばれた時点で停止は確定。既存データ混在での誤停止は
 *       scanCollectionForDuplicates の isStructuredSettlementDocId フィルタで除外済み。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Array} duplicates
 */
async function handleDuplicatesDetected(db, duplicates) {
  // 即停止
  try {
    await disableAutomation(db, {
      disabledBy: 'duplicate_detector',
      disabledReason: `二重作成検知: ${duplicates.length}件（${JSON.stringify(duplicates).slice(0, 300)}）`,
    })
  } catch (err) {
    // disable 自体の失敗は Cloud Logging に残して通知は続ける
    // eslint-disable-next-line no-console
    console.error('[detectDuplicates] disableAutomation failed', err)
  }

  // admin 通知（critical）
  try {
    await notifyAdmin({
      severity: 'critical',
      title: '【緊急】二重作成を検知しました',
      body: `自動作成機構を即停止しました。\n` +
            `件数: ${duplicates.length}\n` +
            `詳細:\n${JSON.stringify(duplicates, null, 2).slice(0, 3000)}\n\n` +
            `対応:\n` +
            `  1. Firestore Console で該当 docId を確認\n` +
            `  2. 片方を論理削除（isDeprecated:true）\n` +
            `  3. 原因特定後に settings/settlement_automation.enabled=true で再開`,
      source: 'detectDuplicates',
      context: { duplicates },
      dedupeKey: `duplicate_creation_${new Date().toISOString().slice(0, 10)}`,
    })
  } catch (err) {
    // notifyAdmin の失敗も非致命（Cloud Logging に残っている前提）
    // eslint-disable-next-line no-console
    console.error('[detectDuplicates] notifyAdmin failed', err)
  }
}

// =====================================================================
// 本体: runDetectDuplicates
// =====================================================================

/**
 * 二重作成検知の本体処理。
 *
 * @param {object} params
 * @param {'post_batch'|'scheduled_daily'|'manual'} params.triggeredBy
 * @param {string} [params.targetMonth]  - post_batch 時の対象月
 * @returns {Promise<object>} 検知結果サマリ
 */
async function runDetectDuplicates({ triggeredBy, targetMonth = null } = {}) {
  if (!TRIGGERED_BY_ALLOWED.includes(triggeredBy)) {
    throw new Error(
      `runDetectDuplicates: invalid triggeredBy=${JSON.stringify(triggeredBy)}. ` +
      `Must be one of [${TRIGGERED_BY_ALLOWED.join(', ')}]`,
    )
  }

  const db = getFirestore()
  const collections = ['kickbacks', 'invoices']

  // --- 走査 ---
  let scannedTotal = 0
  let structuredCount = 0
  let legacyCount = 0
  const allDuplicates = []

  for (const col of collections) {
    const r = await scanCollectionForDuplicates(db, col)
    scannedTotal += r.scannedTotal
    structuredCount += r.structuredCount
    legacyCount += r.legacyCount
    allDuplicates.push(...r.duplicates)
  }

  // --- 監査記録（append-only） ---
  let checkId = null
  try {
    checkId = await writeDuplicateCheck(db, {
      triggeredBy,
      targetMonth,
      checkedCollections: collections,
      scannedTotal,
      structuredCount,
      legacyCount,
      duplicates: allDuplicates,
    })
  } catch (err) {
    // 監査記録失敗は notifyAdmin に託す（自動停止は止めない）
    // eslint-disable-next-line no-console
    console.error('[detectDuplicates] writeDuplicateCheck failed', err)
    try {
      await notifyAdmin({
        severity: 'warning',
        title: 'settlementDuplicateChecks 書き込み失敗',
        body: `triggeredBy=${triggeredBy} targetMonth=${targetMonth || 'N/A'}\n` +
              `検知結果は失われた可能性があります。Cloud Logging を確認してください。\n` +
              `error: ${err && err.message ? err.message : String(err)}`,
        source: 'detectDuplicates',
      })
    } catch (_e) { /* ignore */ }
  }

  // --- 重複検知時の停止処理 ---
  if (allDuplicates.length > 0) {
    await handleDuplicatesDetected(db, allDuplicates)
  }

  return {
    triggeredBy,
    targetMonth,
    checkedCollections: collections,
    scannedTotal,
    structuredCount,
    legacyCount,
    duplicatesFound: allDuplicates.length,
    duplicates: allDuplicates,
    checkId,
    stopped: allDuplicates.length > 0,
  }
}

// =====================================================================
// onCall エクスポート（admin 手動）
// =====================================================================

const detectDuplicates = onCall(
  {
    region: REGION,
    timeoutSeconds: TIMEOUT_SECONDS,
    memory: MEMORY,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }

    const db = getFirestore()
    const callerSnap = await db.collection('users').doc(request.auth.uid).get()
    const caller = callerSnap.exists ? callerSnap.data() : null
    if (!caller || !['admin', 'master'].includes(caller.role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    const { targetMonth } = request.data || {}

    try {
      const result = await runDetectDuplicates({
        triggeredBy: 'manual',
        targetMonth: targetMonth || null,
      })
      return result
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[detectDuplicates onCall] failed', err)
      throw new HttpsError('internal', err && err.message ? err.message : String(err))
    }
  },
)

// =====================================================================
// onSchedule エクスポート（毎日 01:00 JST）
// =====================================================================

const detectDuplicatesScheduled = onSchedule(
  {
    schedule: '0 1 * * *',
    timeZone: 'Asia/Tokyo',
    region: REGION,
    timeoutSeconds: TIMEOUT_SECONDS,
    memory: MEMORY,
    retryCount: 0, // 自動リトライ無効（§1.7）
  },
  async (_event) => {
    try {
      const result = await runDetectDuplicates({ triggeredBy: 'scheduled_daily' })
      // eslint-disable-next-line no-console
      console.log('[detectDuplicatesScheduled] done', result)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[detectDuplicatesScheduled] failed', err)
      try {
        await notifyAdmin({
          severity: 'critical',
          title: '【緊急】二重作成検知（日次保険）が失敗',
          body: `Scheduler 実行時に例外が発生しました。\n` +
                `error: ${err && err.message ? err.message : String(err)}`,
          source: 'detectDuplicatesScheduled',
        })
      } catch (_e) { /* ignore */ }
      throw err
    }
  },
)

module.exports = {
  detectDuplicates,
  detectDuplicatesScheduled,
  runDetectDuplicates,
  // テスト・内部再利用用
  scanCollectionForDuplicates,
  handleDuplicatesDetected,
  TRIGGERED_BY_ALLOWED,
  SCRIPT_VERSION,
}
