/**
 * createMonthlySettlement.js
 *
 * Phase 2 段階1 月次自動作成の本体。
 *
 * 設計書: docs/05_PHASE2_AUTOMATION.md §1.3〜§1.9, §3.3
 *
 * エクスポート:
 *   - createMonthlySettlement        : onCall（admin 手動トリガー）
 *   - createMonthlySettlementScheduled : onSchedule（毎月1日03:00 JST）
 *   - runCreateMonthlySettlement     : 内部関数（テスト・他関数からの呼び出し用）
 *
 * 設計上の遵守事項（本線指示 v0.8）:
 *   1. 既存 UI を壊さない。今回は create の新経路追加のみ
 *      kickbacks / invoices の rules 厳格化は後続段階
 *   2. dryRun を先に成立させる（write しないパスを確実に用意）
 *   3. post_batch detectDuplicates は失敗しても create 結果を壊さない
 *      create 成功分は rollback しない
 *   4. enabled の再確認は代理店ループの各イテレーションで毎回行う
 *   5. runLogs は append-only 前提の確定スキーマで書き込む
 *
 * 処理フロー（概要）:
 *   [1] assertAutomationEnabled（まず全体停止判定）
 *   [2] validateInputs（targetMonth / dryRun）
 *   [3] resolveTargetDealers（dealers コレクションから active なもの）
 *   [4] 代理店ループ
 *        a. enabled を再確認（false 検知後は残り全件 skip）
 *        b. classifyDealer（kbGroup → type 判定）
 *        c. tx.create（dryRun=false 時のみ）
 *        d. 失敗は failed 配列に記録
 *   [5] writeRunLog（dryRun=false 時のみ）
 *   [6] postBatchDuplicateCheck（try-catch で非致命、dryRun=false 時のみ）
 *   [7] 戻り値返却
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore')

const {
  validateMonth,
  validateDealerCode,
  buildSettlementDocId,
  resolveCollectionName,
  previousMonth,
  SKIP_REASONS,
} = require('./lib/settlementIdUtils')

const {
  isAutomationEnabled,
  assertAutomationEnabled,
} = require('./lib/settlementAutomation')

const { notifyAdmin } = require('./lib/notifyAdmin')

// =====================================================================
// 設定値
// =====================================================================

const REGION = 'asia-northeast1'
const TIMEOUT_SECONDS = 540
const MEMORY = '512MiB'
const MAX_INSTANCES = 1
const SCRIPT_VERSION = '2026-04-20.phase2-1.v1'

// settlementRunLogs.skipped[] / failed[] の配列上限（§3.3）
// 超過分は arrayTruncated: true + originalCount で記録し Cloud Logging を補助に
const MAX_ARRAY_SIZE = 500

// =====================================================================
// 型判定（kbGroup → type）
// =====================================================================

/**
 * 代理店の kbGroup から精算 type を決定する。
 *
 * - kbGroup: 'A' | 'B' → type: 'kb'（kickbacks コレクション）
 * - kbGroup: 'C'       → type: 'invoice'（invoices コレクション）
 * - それ以外・未設定    → null を返し、呼び出し側で 'no_kbGroup' スキップ扱い
 *
 * @param {object} dealer - dealers コレクションのドキュメントデータ
 * @returns {'kb'|'invoice'|null}
 */
function classifyDealer(dealer) {
  const g = dealer && dealer.kbGroup
  if (g === 'A' || g === 'B') return 'kb'
  if (g === 'C') return 'invoice'
  return null
}

// =====================================================================
// dealers 取得
// =====================================================================

/**
 * 対象代理店（active === true）を取得する。
 * dealerCode が J 形式でないものは除外（validateDealerCode で弾かれる）。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<Array<{dealerCode: string, data: object}>>}
 */
async function resolveTargetDealers(db) {
  const snap = await db.collection('dealers')
    .where('active', '==', true)
    .get()

  const dealers = []
  for (const doc of snap.docs) {
    const data = doc.data() || {}
    const dealerCode = data.dealerCode || doc.id
    // dealerCode が J 形式でない dealer はスキップ（構造化 docId が作れない）
    try {
      validateDealerCode(dealerCode)
    } catch (_e) {
      // 不正 dealerCode は warn ログのみ（本運用では Phase 1 で統一済みのはず）
      // eslint-disable-next-line no-console
      console.warn(`[resolveTargetDealers] skip non-J dealerCode=${dealerCode}`)
      continue
    }
    dealers.push({ dealerCode, data })
  }
  return dealers
}

// =====================================================================
// 配列切り詰め（§3.3 overflow/ 撤回版）
// =====================================================================

/**
 * skipped / failed 配列が MAX_ARRAY_SIZE を超える場合に切り詰める。
 * §3.3 の新方針：overflow/ サブコレクションは採用せず、
 * 新しい順で切り詰め + 通知 + Cloud Logging 補助とする。
 *
 * @param {Array} skipped
 * @param {Array} failed
 * @returns {{ skipped: Array, failed: Array, arrayTruncated: boolean, originalSkippedCount: number, originalFailedCount: number }}
 */
function truncateIfNeeded(skipped, failed) {
  const originalSkippedCount = skipped.length
  const originalFailedCount = failed.length

  if (originalSkippedCount + originalFailedCount <= MAX_ARRAY_SIZE) {
    return { skipped, failed, arrayTruncated: false, originalSkippedCount, originalFailedCount }
  }

  // 新しい順を優先して切り詰め（新しい事象の方が調査価値が高い）
  const halfCap = Math.floor(MAX_ARRAY_SIZE / 2)
  const skippedCap = Math.min(originalSkippedCount, halfCap)
  const failedCap = MAX_ARRAY_SIZE - skippedCap

  return {
    skipped: skipped.slice(-skippedCap),
    failed: failed.slice(-failedCap),
    arrayTruncated: true,
    originalSkippedCount,
    originalFailedCount,
  }
}

// =====================================================================
// run log 書き込み
// =====================================================================

/**
 * settlementRunLogs に 1 ドキュメントを書き込む。
 * §3.3 スキーマに準拠。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} entry
 * @returns {Promise<string>} runLogId
 */
async function writeRunLog(db, entry) {
  const { skipped, failed, arrayTruncated, originalSkippedCount, originalFailedCount } =
    truncateIfNeeded(entry.skipped, entry.failed)

  // type='creation' で作成バッチを明示（§2.3 v0.8 拡張）
  const ref = await db.collection('settlementRunLogs').add({
    type: 'creation',
    targetMonth: entry.targetMonth,
    trigger: entry.trigger,
    operator: entry.operator,
    operatorEmail: entry.operatorEmail || null,

    targetDealerCount: entry.targetDealerCount,
    createdCount: entry.createdCount,
    skippedCount: originalSkippedCount,
    failedCount: originalFailedCount,

    skipped,
    failed,
    arrayTruncated,
    originalSkippedCount,
    originalFailedCount,

    status: entry.status,
    durationMs: entry.durationMs,
    scriptVersion: SCRIPT_VERSION,
    environmentFlags: entry.environmentFlags || {},

    runAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  })

  return ref.id
}

// =====================================================================
// 単一代理店の tx.create
// =====================================================================

/**
 * 1 代理店 1 月分の精算ドキュメントを transaction で create する。
 *
 * 重要:
 *   - tx.create() を使う（既存があれば throw）
 *   - 既存検知は throw ではなく戻り値 { skipped: true, reason: 'already_exists' } で返す
 *   - validate 系の throw はそのまま上位に伝播（呼び出し側で failed に落とす）
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} params
 * @returns {Promise<{ skipped: boolean, reason?: string, existingStatus?: string, docId: string }>}
 */
async function createOneSettlementInTx(db, { type, dealerCode, dealerName, month, companyName, kbGroup }) {
  const docId = buildSettlementDocId({ type, dealerCode, month })
  const collectionName = resolveCollectionName(type)
  const docRef = db.collection(collectionName).doc(docId)

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef)
    if (snap.exists) {
      return {
        skipped: true,
        reason: 'already_exists',
        existingStatus: snap.data().status || null,
        docId,
      }
    }

    // 新規 create（Phase 2 段階1 では明細計算はせず、骨組みドキュメントのみ）
    // 理由: §1.3 の思想「再生成しない」「未作成分のみ create」を段階1 で確立するため、
    //       明細集計ロジックは段階2 以降に追加する。
    //       既存 UI（KickbackManage 等）で手動作成されるものと混在する期間があるため、
    //       Cloud Functions 経由の骨組みは status='draft' で admin 確認を待つ。
    tx.create(docRef, {
      // 構造化 docId と一致する識別子
      dealerCode,
      dealerName: dealerName || '',
      month,
      type,
      companyName: companyName || '',
      kbGroup: kbGroup || null,

      // 状態（§1.3 状態遷移表）
      status: 'draft',

      // 明細（段階1 では空、段階2 で自動集計を実装）
      items: [],
      grandTotal: 0,

      // メタデータ
      createdBy: 'scheduler',
      createdSource: 'createMonthlySettlement',
      scriptVersion: SCRIPT_VERSION,
      version: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return { skipped: false, docId }
  })

  return result
}

// =====================================================================
// 本体: runCreateMonthlySettlement
// =====================================================================

/**
 * 月次自動作成の本体処理。
 * onCall / onSchedule の双方から呼ばれ、また他関数・テストからも呼び出し可能。
 *
 * @param {object} params
 * @param {string} [params.targetMonth]  - 省略時は前月を自動算出
 * @param {boolean} [params.dryRun]      - true で Firestore write を一切行わない
 * @param {string} [params.operator]     - 実行者（'scheduler' or admin uid）
 * @param {string} [params.operatorEmail]
 * @param {string} [params.trigger]      - 'scheduler' | 'manual'
 * @returns {Promise<object>} 実行結果サマリ
 */
async function runCreateMonthlySettlement({
  targetMonth = null,
  dryRun = false,
  operator = 'scheduler',
  operatorEmail = null,
  trigger = 'scheduler',
} = {}) {
  const startedAt = Date.now()
  const db = getFirestore()

  // ---- [1] enabled 全体チェック（dryRun でも実データ判断は行う） ----
  // ただし dryRun は enabled=false でも判定結果を返すために assertEnabled を使わない
  const enabledAtStart = await isAutomationEnabled(db)
  if (!enabledAtStart && !dryRun) {
    // disabled な場合でも空の runLog を残すか → 残さない方針
    // 理由: 明示的に無効化された状態で書き込むことは append-only を汚染する
    return {
      status: 'aborted',
      reason: 'automation_disabled',
      targetMonth: targetMonth || previousMonth(),
      targetDealerCount: 0,
      createdCount: 0,
      skippedCount: 0,
      failedCount: 0,
      runLogId: null,
      dryRun,
      durationMs: Date.now() - startedAt,
    }
  }

  // ---- [2] 入力検証 ----
  const resolvedMonth = targetMonth || previousMonth()
  validateMonth(resolvedMonth)

  // ---- [3] 対象代理店 ----
  const dealers = await resolveTargetDealers(db)

  const skipped = []
  const failed = []
  let createdCount = 0
  let midrunDisabled = false

  // ---- [4] 代理店ループ（enabled break 離脱構造 §1.6 シナリオ6） ----
  // 方針:
  //   - 初期は enabledAtStart 結果を流用
  //   - ループの各イテレーションで毎回 Firestore を read（false 検知後は追加 read しない）
  let enabled = enabledAtStart

  for (const dealer of dealers) {
    // enabled 再確認（false を一度でも検知したら追加 read せず break）
    if (!enabled) {
      skipped.push({
        dealerCode: dealer.dealerCode,
        reason: 'automation_disabled_midrun',
      })
      midrunDisabled = true
      continue
    }

    // dryRun でも enabled チェックは現実に行う（本番相当のコストを体感するため）
    try {
      enabled = await isAutomationEnabled(db)
    } catch (_e) {
      enabled = false
    }
    if (!enabled) {
      skipped.push({
        dealerCode: dealer.dealerCode,
        reason: 'automation_disabled_midrun',
      })
      midrunDisabled = true
      continue
    }

    // 代理店分類
    const type = classifyDealer(dealer.data)
    if (!type) {
      skipped.push({
        dealerCode: dealer.dealerCode,
        reason: 'no_kbGroup',
      })
      continue
    }

    // dryRun: write しないで docId を組み立てるだけ
    if (dryRun) {
      try {
        const docId = buildSettlementDocId({ type, dealerCode: dealer.dealerCode, month: resolvedMonth })
        // 既存チェックは read のみ
        const collectionName = resolveCollectionName(type)
        const snap = await db.collection(collectionName).doc(docId).get()
        if (snap.exists) {
          skipped.push({
            dealerCode: dealer.dealerCode,
            reason: 'already_exists',
            existingDocId: docId,
          })
        } else {
          // dryRun では createdCount を「作成されるはずだった件数」として数える
          createdCount += 1
        }
      } catch (err) {
        failed.push({
          dealerCode: dealer.dealerCode,
          errorMessage: String(err && err.message ? err.message : err).slice(0, 500),
          retryable: false,
        })
      }
      continue
    }

    // 本番 create
    try {
      const r = await createOneSettlementInTx(db, {
        type,
        dealerCode: dealer.dealerCode,
        dealerName: dealer.data.name || dealer.data.dealerName || '',
        month: resolvedMonth,
        companyName: dealer.data.companyName || '',
        kbGroup: dealer.data.kbGroup || null,
      })
      if (r.skipped) {
        skipped.push({
          dealerCode: dealer.dealerCode,
          reason: r.reason,
          existingDocId: r.docId,
          existingStatus: r.existingStatus || null,
        })
      } else {
        createdCount += 1
      }
    } catch (err) {
      failed.push({
        dealerCode: dealer.dealerCode,
        errorMessage: String(err && err.message ? err.message : err).slice(0, 1000),
        retryable: false,
      })
    }
  }

  // ---- status 判定 ----
  let status
  if (midrunDisabled) status = 'aborted'
  else if (failed.length === 0) status = 'success'
  else if (createdCount > 0) status = 'partial_success'
  else status = 'failed'

  const durationMs = Date.now() - startedAt

  // ---- [5] runLogs 書き込み（dryRun では書かない） ----
  let runLogId = null
  if (!dryRun) {
    try {
      runLogId = await writeRunLog(db, {
        targetMonth: resolvedMonth,
        trigger,
        operator,
        operatorEmail,
        targetDealerCount: dealers.length,
        createdCount,
        skipped,
        failed,
        status,
        durationMs,
        environmentFlags: {
          enabledAtStart,
          enabledAtEnd: enabled,
        },
      })
    } catch (err) {
      // runLog 書き込み失敗は致命的だが、create 本体は既に完了している
      // Cloud Logging にフォールバック + notifyAdmin（critical）
      // eslint-disable-next-line no-console
      console.error('[createMonthlySettlement] runLog write failed', err)
      try {
        await notifyAdmin({
          severity: 'critical',
          title: '【緊急】settlementRunLogs 書き込み失敗',
          body: `month=${resolvedMonth} 作成件数=${createdCount} を Firestore に記録できませんでした。\n` +
                `Cloud Logging で元データを確認してください。\n` +
                `error: ${err && err.message ? err.message : String(err)}`,
          source: 'createMonthlySettlement',
          context: { targetMonth: resolvedMonth, createdCount, failed: failed.length },
        })
      } catch (_e) { /* notifyAdmin 内部で握りつぶし */ }
    }
  }

  // ---- [6] post_batch detectDuplicates（非致命） ----
  // 本線指示: 失敗しても create 結果は壊さない。create 成功分は rollback しない。
  // 実装は Step C の detectDuplicates が完成してから有効化する。
  // 段階1 では「段階的有効化」のため、ここでは呼び出し口だけ用意し遅延読込にする。
  if (!dryRun && createdCount > 0) {
    try {
      // 遅延 require: Step C 未実装段階でも動くよう、try 内で require する
      // eslint-disable-next-line global-require
      const mod = tryRequire('./detectDuplicates')
      if (mod && typeof mod.runDetectDuplicates === 'function') {
        await mod.runDetectDuplicates({
          triggeredBy: 'post_batch',
          targetMonth: resolvedMonth,
        })
      }
    } catch (err) {
      // create 本体は成功しているので failed 扱いにはしない。warning 通知のみ
      // eslint-disable-next-line no-console
      console.error('[createMonthlySettlement] post_batch detectDuplicates failed', err)
      try {
        await notifyAdmin({
          severity: 'warning',
          title: 'post_batch detectDuplicates が失敗',
          body: `月次バッチ自体は成功しましたが、直後の二重作成検知に失敗しました。\n` +
                `日次保険（scheduled_daily）で検知されるため create 結果は保持します。\n` +
                `error: ${err && err.message ? err.message : String(err)}`,
          source: 'createMonthlySettlement',
          context: { targetMonth: resolvedMonth, runLogId },
        })
      } catch (_e) { /* ignore */ }
    }
  }

  return {
    status,
    targetMonth: resolvedMonth,
    targetDealerCount: dealers.length,
    createdCount,
    skippedCount: skipped.length,
    failedCount: failed.length,
    runLogId,
    dryRun,
    durationMs,
  }
}

/**
 * require を安全に試みる（モジュール未存在でも throw しない）。
 * Step C 未完成段階で createMonthlySettlement が動くようにするための保険。
 *
 * @param {string} path
 * @returns {object|null}
 */
function tryRequire(path) {
  try {
    // eslint-disable-next-line global-require
    return require(path)
  } catch (_e) {
    return null
  }
}

// =====================================================================
// onCall エクスポート（admin 手動トリガー）
// =====================================================================

const createMonthlySettlement = onCall(
  {
    region: REGION,
    timeoutSeconds: TIMEOUT_SECONDS,
    memory: MEMORY,
    maxInstances: MAX_INSTANCES,
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

    const { targetMonth, dryRun } = request.data || {}

    try {
      const result = await runCreateMonthlySettlement({
        targetMonth: targetMonth || null,
        dryRun: Boolean(dryRun),
        operator: request.auth.uid,
        operatorEmail: caller.email || null,
        trigger: 'manual',
      })
      return result
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[createMonthlySettlement onCall] failed', err)
      throw new HttpsError('internal', err && err.message ? err.message : String(err))
    }
  },
)

// =====================================================================
// onSchedule エクスポート（毎月1日03:00 JST）
// =====================================================================

const createMonthlySettlementScheduled = onSchedule(
  {
    schedule: '0 3 1 * *',
    timeZone: 'Asia/Tokyo',
    region: REGION,
    timeoutSeconds: TIMEOUT_SECONDS,
    memory: MEMORY,
    retryCount: 0, // 自動リトライ無効（§1.7 原則）
  },
  async (_event) => {
    try {
      const result = await runCreateMonthlySettlement({
        targetMonth: null, // 前月を自動算出
        dryRun: false,
        operator: 'scheduler',
        operatorEmail: null,
        trigger: 'scheduler',
      })
      // eslint-disable-next-line no-console
      console.log('[createMonthlySettlementScheduled] done', result)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[createMonthlySettlementScheduled] failed', err)
      try {
        await notifyAdmin({
          severity: 'critical',
          title: '【緊急】月次バッチ自動実行が失敗',
          body: `Scheduler 実行時に例外が発生しました。\n` +
                `error: ${err && err.message ? err.message : String(err)}`,
          source: 'createMonthlySettlementScheduled',
        })
      } catch (_e) { /* ignore */ }
      // Scheduler からの throw は Cloud Scheduler 側のエラーカウントに影響
      throw err
    }
  },
)

module.exports = {
  createMonthlySettlement,
  createMonthlySettlementScheduled,
  runCreateMonthlySettlement,
  // テスト用
  classifyDealer,
  truncateIfNeeded,
  MAX_ARRAY_SIZE,
  SCRIPT_VERSION,
}
