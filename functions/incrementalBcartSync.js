/**
 * 代理店ポータル「最新データ取得」用 Cloud Function
 *   onCall（asia-northeast1）
 *
 * 目的:
 *   - ユーザーがダッシュボードで「最新データ取得」ボタンを押したとき、
 *     Bカート の最近 N 日（既定 7 日）の orders を取得して Firestore へ upsert。
 *   - スマホで軽く動かすため画面表示時には Bカート を叩かない方針（PR #108 以降）に対し、
 *     ユーザー駆動の同期手段を提供する。
 *
 * スコープ（最小限）:
 *   - 呼び出しユーザーの dealerCode に紐付く注文のみ upsert
 *   - dealerCodeMap（allowedEmails.bcartParentId）を考慮
 *   - items / customer 関連は同期しない（重い処理は scripts/bcart-sync.mjs に任せる）
 *
 * 戻り値:
 *   { success, dealerCode, sinceDays, bcartFetched, matched, created, updated, failed }
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const fetch = require('node-fetch')

const BCART_API = 'https://api.bcart.jp/api/v1'
const PAGE = 100
// 軽量同期 (days=7) 用
const MAX_PAGES_LIGHT = 50 // 5,000 件まで
// 過去データ再取得 (fullSync) 用：1チャンクあたりの上限ページ
const MAX_PAGES_CHUNK = 200 // 20,000 件/チャンクまで
// fullSync の起点（DealerSalons の表示範囲 36ヶ月と整合）
const FULL_SYNC_FROM = '2023-01-01 00:00:00'
// 1 チャンクあたりの日数（タイムアウト回避のため小さめ）
const CHUNK_DAYS = 30

const pad2 = (n) => String(n).padStart(2, '0')
const fmtStart = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 00:00:00`
const fmtEnd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 23:59:59`
const parseStr = (s) => new Date(String(s).replace(' ', 'T'))

exports.runIncrementalBcartSync = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    // 未捕捉例外を必ず HttpsError に包んで詳細メッセージをクライアントに返す。
    // 'internal' のまま渡すと UI で原因が分からない。
    try {
      return await runSyncImpl(request)
    } catch (e) {
      if (e instanceof HttpsError) throw e
      console.error('[runIncrementalBcartSync] unexpected error:', e?.stack || e)
      throw new HttpsError(
        'internal',
        `Bカート 同期で例外発生: ${e?.message || e}`,
        { name: e?.name, stack: e?.stack?.split('\n').slice(0, 5).join(' | ') },
      )
    }
  },
)

async function runSyncImpl(request) {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }
    const db = getFirestore()
    console.log('[runIncrementalBcartSync] start uid=', request.auth.uid, 'data=', request.data)

    // 呼び出しユーザーの dealerCode を取得
    const userDoc = await db.collection('users').doc(request.auth.uid).get()
    const profile = userDoc.exists ? userDoc.data() : null
    const dealerCode = profile?.dealerCode || ''
    if (!dealerCode) {
      throw new HttpsError('failed-precondition', '代理店コードが未設定です')
    }

    // dealer 系 allowedEmails から bcartParentId マッピングを構築
    const allowedSnap = await db
      .collection('allowedEmails')
      .where('role', '==', 'dealer')
      .get()
    const myParents = new Set()
    myParents.add(String(dealerCode).trim())
    for (const d of allowedSnap.docs) {
      const r = d.data() || {}
      if (r.dealerCode === dealerCode && r.bcartParentId) {
        myParents.add(String(r.bcartParentId).trim())
      }
    }

    // 期間モード
    //   通常: days=7 軽量同期（直近1週間）
    //   fullSync=true: 2023-01-01 〜 現在を 30日チャンクに分割し、1リクエスト=1チャンク処理。
    //     resume=true: 前回の続きから（Firestore: bcartSyncState/{dealerCode}）
    //     resume=false / state無し / done済: 起点リセットして最初から
    //   days=N: 任意指定（fullSync 優先）
    const fullSync = request.data?.fullSync === true
    const resume = request.data?.resume === true
    const days = fullSync
      ? null
      : Math.max(1, Math.min(365, Number(request.data?.days) || 7))

    // fullSync 進捗保存先
    const stateRef = db.collection('bcartSyncState').doc(dealerCode)
    let chunkState = null

    let sinceStr
    let nowStr
    let maxPages
    let targetEndStr // fullSync 時のゴール

    if (fullSync) {
      const snap = await stateRef.get()
      const prev = snap.exists ? snap.data() : null
      if (!resume || !prev || prev.done) {
        // 新規開始
        chunkState = {
          mode: 'fullSync',
          nextFromDate: FULL_SYNC_FROM,
          targetEndDate: fmtEnd(new Date()),
          totalFetched: 0,
          totalMatched: 0,
          totalCreated: 0,
          totalUpdated: 0,
          totalFailed: 0,
          chunksProcessed: 0,
          done: false,
          startedAt: FieldValue.serverTimestamp(),
          lastRunAt: null,
        }
      } else {
        chunkState = { ...prev }
      }
      // チャンク窓 [nextFromDate, nextFromDate + CHUNK_DAYS]（targetEndDate でキャップ）
      const fromD = parseStr(chunkState.nextFromDate)
      const targetEndD = parseStr(chunkState.targetEndDate)
      const chunkEndD = new Date(fromD.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000 - 1000)
      const actualEndD = chunkEndD > targetEndD ? targetEndD : chunkEndD
      sinceStr = chunkState.nextFromDate
      nowStr = fmtEnd(actualEndD)
      targetEndStr = chunkState.targetEndDate
      maxPages = MAX_PAGES_CHUNK
    } else {
      const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      sinceStr = fmtStart(d)
      nowStr = fmtEnd(new Date())
      maxPages = MAX_PAGES_LIGHT
    }

    const token = process.env.BCART_API_TOKEN
    if (!token) {
      throw new HttpsError('internal', 'Bカート APIトークンが未設定です')
    }

    console.log('[runIncrementalBcartSync] sync params', { dealerCode, fullSync, resume, days, fromDate: sinceStr, toDate: nowStr, targetEndDate: targetEndStr, maxPages, parents: [...myParents] })

    // Bカート 受注 取得（ページング）
    const fetched = []
    for (let i = 0; i < maxPages; i += 1) {
      const offset = i * PAGE
      const url = `${BCART_API}/orders?limit=${PAGE}&offset=${offset}&ordered_at__gte=${encodeURIComponent(sinceStr)}&ordered_at__lte=${encodeURIComponent(nowStr)}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        throw new HttpsError('internal', `Bカート API エラー: ${res.status} (page=${i + 1})`)
      }
      const data = await res.json()
      const items = data?.orders || []
      fetched.push(...items)
      const total = data?.meta?.total ?? fetched.length
      if (items.length === 0 || fetched.length >= total) break
      // safety: 5 ページごとに進捗ログ
      if ((i + 1) % 5 === 0) console.log(`[runIncrementalBcartSync] fetched ${fetched.length}/${total} pages=${i + 1}`)
    }

    // 自代理店（と紐付く bcartParentId）に該当する注文だけ
    const mine = fetched.filter((o) =>
      myParents.has(String(o.customer_parent_id || '').trim()),
    )

    // Firestore へ upsert（docId = bcart order id）
    let created = 0
    let updated = 0
    let failed = 0
    for (const o of mine) {
      const docId = String(o.id)
      try {
        const ref = db.collection('orders').doc(docId)
        const existing = await ref.get()
        const od = o.ordered_at ? new Date(o.ordered_at.replace(' ', 'T')) : null
        const data = {
          dealerCode,
          bcartOrderId: o.id,
          bcartOrderNumber: o.code || String(o.id),
          bcartCode: o.code || '',
          orderDate: od,
          companyName: o.customer_comp_name || o.customer_name || '',
          contact: o.customer_name || '',
          email: o.customer_email || '',
          phone: o.customer_tel || '',
          subtotal: Number(o.total_price) || 0,
          tax: Number(o.tax) || 0,
          total: Number(o.final_price) || 0,
          paymentMethod: o.payment || '',
          status: o.status || '',
          source: 'bcart-api-incremental',
          syncedAt: FieldValue.serverTimestamp(),
        }
        if (!existing.exists) data.createdAt = FieldValue.serverTimestamp()
        await ref.set(data, { merge: true })
        if (existing.exists) updated += 1
        else created += 1
      } catch (e) {
        failed += 1
        console.warn('[runIncrementalBcartSync] upsert failed:', docId, e?.message)
      }
    }

    console.log('[runIncrementalBcartSync] chunk done', { dealerCode, fullSync, fromDate: sinceStr, toDate: nowStr, fetched: fetched.length, matched: mine.length, created, updated, failed })

    // fullSync の進捗を Firestore に保存して done 判定
    if (fullSync && chunkState) {
      const targetEndD = parseStr(chunkState.targetEndDate)
      const chunkEndD = parseStr(nowStr)
      const isDone = chunkEndD.getTime() >= targetEndD.getTime()
      // 次回起点 = チャンク終端 +1 秒（直後の 00:00:00 にしたい場合は翌日 00:00 でも可）
      const nextFromD = new Date(chunkEndD.getTime() + 1000)
      const nextFromStr = isDone ? chunkState.nextFromDate : fmtStart(nextFromD)
      const updatedState = {
        mode: 'fullSync',
        nextFromDate: nextFromStr,
        targetEndDate: chunkState.targetEndDate,
        totalFetched: (chunkState.totalFetched || 0) + fetched.length,
        totalMatched: (chunkState.totalMatched || 0) + mine.length,
        totalCreated: (chunkState.totalCreated || 0) + created,
        totalUpdated: (chunkState.totalUpdated || 0) + updated,
        totalFailed: (chunkState.totalFailed || 0) + failed,
        chunksProcessed: (chunkState.chunksProcessed || 0) + 1,
        done: isDone,
        lastRunAt: FieldValue.serverTimestamp(),
        startedAt: chunkState.startedAt || FieldValue.serverTimestamp(),
        lastFromDate: sinceStr,
        lastToDate: nowStr,
      }
      await stateRef.set(updatedState, { merge: true })
      console.log('[runIncrementalBcartSync] fullSync state', { dealerCode, done: isDone, nextFromDate: isDone ? null : nextFromStr, totalFetched: updatedState.totalFetched })
      return {
        success: true,
        dealerCode,
        fullSync: true,
        done: isDone,
        fromDate: sinceStr,
        toDate: nowStr,
        nextFromDate: isDone ? null : nextFromStr,
        targetEndDate: chunkState.targetEndDate,
        bcartFetched: fetched.length,
        matched: mine.length,
        created,
        updated,
        failed,
        totalFetched: updatedState.totalFetched,
        totalMatched: updatedState.totalMatched,
        totalCreated: updatedState.totalCreated,
        totalUpdated: updatedState.totalUpdated,
        totalFailed: updatedState.totalFailed,
        chunksProcessed: updatedState.chunksProcessed,
      }
    }

    return {
      success: true,
      dealerCode,
      sinceDays: days,
      fullSync: false,
      done: true,
      fromDate: sinceStr,
      toDate: nowStr,
      bcartFetched: fetched.length,
      matched: mine.length,
      created,
      updated,
      failed,
    }
}
