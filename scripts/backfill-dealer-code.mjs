/**
 * orders コレクション dealerCode バックフィルスクリプト（Admin SDK + Bカート API）
 *
 * 目的:
 *   既存の orders に `dealerCode` フィールドを追加する。
 *   ソース・オブ・トゥルースは Bカート受注データの `customer_parent_id` フィールド。
 *   Bカート API から全受注を取得 → bcartOrderNumber / bcartOrderId で Firestore orders とマッチング →
 *   customer_parent_id を dealerCode として書き込む。
 *
 * 設計方針（社長確定の3要件 + 追記ルール）:
 *   1. ドライラン既定   — 実際に書き込むのは DRY_RUN=false を明示した時のみ
 *   2. 再実行安全       — 既に dealerCode フィールドがある orders はスキップ（冪等）
 *   3. Firestore ログ   — 実行ごとに ordersBackfillLogs コレクションへ監査ログを残す
 *   4. 解決不能は更新禁止 — Bカート側で該当なし or parent 空の orders は update しない。
 *                         failedEntries に { orderId, companyName, reason } を必ず残す。
 *                         （旧版は dealerCode='' を保存していたが、サイレント上書きを避けるため変更）
 *
 * 使用方法:
 *   # ドライラン（既定）
 *   node scripts/backfill-dealer-code.mjs
 *
 *   # 本番実行
 *   DRY_RUN=false node scripts/backfill-dealer-code.mjs
 *
 *   # 既に dealerCode が入っている orders も再解決する
 *   RE_RESOLVE=true DRY_RUN=false node scripts/backfill-dealer-code.mjs
 *
 *   # 記録者メモ
 *   OPERATOR="社長 ボンバー" DRY_RUN=false node scripts/backfill-dealer-code.mjs
 *
 * 必要な環境変数（.env.local）:
 *   VITE_BCART_API_TOKEN
 *
 * 必要な認証ファイル:
 *   scripts/service-account.json（Firebase Admin SDK 秘密鍵）
 *
 * 出力:
 *   - 標準出力: サマリ + 未解決 orders サンプル
 *   - ファイル: scripts/logs/unresolved-orders-<timestamp>.json（人手調査用）
 *   - Firestore: orders/{id}.dealerCode フィールド（本番実行時のみ、解決できたものだけ）
 *   - Firestore: ordersBackfillLogs/{auto-id} に実行サマリを保存
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { BCART_BASE, getBcartToken } from './_env.mjs'

const SERVICE_ACCOUNT_PATH = new URL('./service-account.json', import.meta.url)

if (!existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ scripts/service-account.json が見つかりません。')
  console.error('   Firebase Console → プロジェクト設定 → サービスアカウント → 新しい秘密鍵 で取得してください。')
  process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'))
initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore()

const BCART_TOKEN = getBcartToken()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const RE_RESOLVE = process.env.RE_RESOLVE === 'true'
const OPERATOR = process.env.OPERATOR || 'unknown'
const BATCH_SIZE = 400
const BCART_PAGE_SIZE = 100

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = `${__dirname}/logs`

// === Bカート API（レート制限対応） ===
async function bcartFetch(endpoint, params = {}) {
  const url = new URL(`${BCART_BASE}/${endpoint}`)
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  })
  for (let retry = 0; retry < 5; retry++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${BCART_TOKEN}` },
    })
    if (res.status === 429) {
      const wait = (retry + 1) * 3000
      console.log(`   ⏳ レート制限 → ${wait / 1000}秒待機...`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new Error(`Bカート API error: ${res.status} ${res.statusText}`)
    return res.json()
  }
  throw new Error('レート制限が継続中。しばらく待ってから再実行してください。')
}

async function fetchAllBcartOrders() {
  const all = []
  let offset = 0
  while (true) {
    const data = await bcartFetch('orders', { limit: BCART_PAGE_SIZE, offset })
    const items = data.orders || []
    if (items.length === 0) break
    all.push(...items)
    const total = data.meta?.total || all.length
    process.stdout.write(`\r  Bカート取得中: ${all.length}/${total} 件`)
    if (all.length >= total) break
    offset += BCART_PAGE_SIZE
  }
  process.stdout.write('\n')
  return all
}

async function main() {
  console.log('=== orders dealerCode バックフィル ===')
  console.log(`モード       : ${DRY_RUN ? '🟡 DRY RUN（書き込みなし）' : '🔴 本番実行（書き込みあり）'}`)
  console.log(`再解決モード : ${RE_RESOLVE ? 'ON（既に dealerCode がある orders も対象）' : 'OFF（未設定のみ）'}`)
  console.log(`OPERATOR     : ${OPERATOR}`)
  console.log('')

  // 1. Bカート受注を全件取得 → bcartOrderNumber / id → customer_parent_id の Map 構築
  console.log('▶ Bカート 全受注取得中...')
  const bcartOrders = await fetchAllBcartOrders()
  const byCode = new Map()
  const byId = new Map()
  bcartOrders.forEach((o) => {
    const parent = String(o.customer_parent_id ?? o.parent_id ?? o.parent_member_id ?? '').trim()
    if (o.code) byCode.set(String(o.code), parent)
    if (o.id != null) byId.set(String(o.id), parent)
  })
  console.log(`  Bカート受注: ${bcartOrders.length} 件`)
  console.log(`  customer_parent_id あり: ${bcartOrders.filter((o) => String(o.customer_parent_id ?? '').trim()).length} 件`)
  console.log('')

  // 2. Firestore orders 全件スキャン
  console.log('▶ Firestore orders 全件スキャン中...')
  const ordersSnap = await db.collection('orders').get()
  console.log(`  orders 総件数: ${ordersSnap.size} 件`)
  console.log('')

  // 3. マッチングしながら更新対象を特定
  //    追記ルール: 解決不能 orders は絶対に update しない。failedEntries に残す。
  const toUpdate = []
  const failedEntries = [] // 解決不能 orders の全件（社長が人手で調査するための一覧）
  const unresolvedSamples = [] // 標準出力用（最大30件サンプル）
  const unresolvedByCompany = new Map() // companyName → count（未解決集計）
  let alreadySet = 0
  let resolved = 0
  let unresolvedNoBcartMatch = 0 // Bカート側で該当受注が見つからない
  let unresolvedNoParent = 0 // Bカート受注はあるが parent_id が空
  let changedByReResolve = 0

  ordersSnap.forEach((d) => {
    const data = d.data()
    const currentDealerCode = data.dealerCode

    if (currentDealerCode !== undefined && !RE_RESOLVE) {
      alreadySet++
      return
    }

    // Bカート受注とのマッチング（bcartOrderNumber / bcartCode / bcartOrderId の順で試す）
    let parent = ''
    let matchedKey = null
    const code = data.bcartOrderNumber || data.bcartCode
    const bId = data.bcartOrderId
    if (code && byCode.has(String(code))) {
      parent = byCode.get(String(code))
      matchedKey = `code:${code}`
    } else if (bId != null && byId.has(String(bId))) {
      parent = byId.get(String(bId))
      matchedKey = `id:${bId}`
    }

    // 解決不能: matchedKey が無い（Bカート受注が見つからない）or parent が空
    if (!matchedKey || !parent) {
      const reason = !matchedKey
        ? 'Bカート側に該当受注なし'
        : 'Bカート側に parent_id なし（未紐付けサロン）'
      if (!matchedKey) unresolvedNoBcartMatch++
      else unresolvedNoParent++

      const cn = data.companyName || '(不明)'
      unresolvedByCompany.set(cn, (unresolvedByCompany.get(cn) || 0) + 1)

      // failedEntries には全件残す（追記ルール③準拠）
      failedEntries.push({
        orderId: d.id,
        companyName: data.companyName || null,
        reason,
        bcartOrderNumber: data.bcartOrderNumber || data.bcartCode || null,
        bcartOrderId: data.bcartOrderId || null,
        source: data.source || null,
      })
      if (unresolvedSamples.length < 30) {
        unresolvedSamples.push({
          docId: d.id,
          reason,
          bcartOrderNumber: data.bcartOrderNumber || data.bcartCode || null,
          bcartOrderId: data.bcartOrderId || null,
          companyName: data.companyName || null,
          source: data.source || null,
        })
      }
      // 解決不能なので toUpdate に積まない（旧版の dealerCode='' サイレント保存はやめる）
      return
    }

    // ここから解決成功ケースのみ
    resolved++

    // RE_RESOLVE 時、新旧が同じならスキップ
    if (RE_RESOLVE && currentDealerCode === parent) {
      return
    }

    if (RE_RESOLVE && currentDealerCode !== undefined && currentDealerCode !== parent) {
      changedByReResolve++
    }

    toUpdate.push({
      id: d.id,
      newDealerCode: parent,
      previousDealerCode: currentDealerCode === undefined ? '(未設定)' : currentDealerCode,
    })
  })

  // 4. 書き込み（本番実行時のみ）
  const writeErrors = [] // 書き込み中のエラーも failed として扱う
  if (!DRY_RUN && toUpdate.length > 0) {
    console.log(`▶ 書き込み開始: ${toUpdate.length} 件を ${BATCH_SIZE} 件ずつバッチ処理...`)
    let written = 0
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const chunk = toUpdate.slice(i, i + BATCH_SIZE)
      const batch = db.batch()
      chunk.forEach((item) => {
        batch.update(db.collection('orders').doc(item.id), { dealerCode: item.newDealerCode })
      })
      try {
        await batch.commit()
        written += chunk.length
        console.log(`  ${written}/${toUpdate.length} 件 書き込み完了`)
      } catch (e) {
        // バッチ単位で失敗した場合は全 chunk を writeErrors に積む
        chunk.forEach((item) => {
          writeErrors.push({
            orderId: item.id,
            reason: `batch.commit 失敗: ${e.message}`,
          })
        })
        console.error(`  ❌ バッチ失敗（${chunk.length} 件）: ${e.message}`)
      }
    }
    console.log('')
  }

  // 5. 未解決サンプル + companyName 集計を JSON 保存
  let logFile = null
  const totalUnresolved = unresolvedNoBcartMatch + unresolvedNoParent
  const unresolvedCompaniesSorted = Array.from(unresolvedByCompany.entries())
    .map(([name, count]) => ({ companyName: name, orderCount: count }))
    .sort((a, b) => b.orderCount - a.orderCount)
  if (totalUnresolved > 0) {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    logFile = `${LOGS_DIR}/unresolved-orders-${ts}.json`
    writeFileSync(
      logFile,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          dryRun: DRY_RUN,
          reResolve: RE_RESOLVE,
          operator: OPERATOR,
          totalUnresolvedOrders: totalUnresolved,
          unresolvedNoBcartMatch,
          unresolvedNoParent,
          uniqueCompanyCount: unresolvedCompaniesSorted.length,
          companies: unresolvedCompaniesSorted,
          samples: unresolvedSamples,
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  // 6. Firestore 監査ログ書き込み（dry-run / production 両方で残す）
  //    PR #7 の subRoleBackfillLogs と同じパターン。運用履歴を完全追跡可能にする。
  const totalFailed = failedEntries.length + writeErrors.length
  try {
    const logRef = await db.collection('ordersBackfillLogs').add({
      type: 'orders-dealer-code-backfill',
      mode: DRY_RUN ? 'dry-run' : 'production',
      runAt: FieldValue.serverTimestamp(),
      operator: OPERATOR,
      reResolve: RE_RESOLVE,
      results: {
        total: ordersSnap.size,
        bcartTotal: bcartOrders.length,
        alreadySet,
        targetCount: toUpdate.length,
        resolved,
        unresolvedNoBcartMatch,
        unresolvedNoParent,
        changedByReResolve,
        failed: totalFailed,
      },
      // 全 orderId を記録するとログが肥大化するため、failedEntries のみ全量残す
      // （解決不能は件数少ない前提、将来的に上限を設ける余地あり）
      failedEntries,
      writeErrors,
      unresolvedCompanies: unresolvedCompaniesSorted, // 全社一覧
      scriptVersion: '2026-04-18.v2',
    })
    console.log(`📝 Firestore 監査ログを保存しました: ordersBackfillLogs/${logRef.id}`)
  } catch (e) {
    console.error('⚠️  Firestore 監査ログ書き込み失敗（処理自体は完了しています）:', e.message)
  }

  // 7. サマリ表示
  console.log('')
  console.log('=== 集計結果 ===')
  console.log(`Firestore orders 総件数  : ${ordersSnap.size}`)
  console.log(`Bカート orders 取得      : ${bcartOrders.length}`)
  console.log(`dealerCode 既設でスキップ : ${alreadySet}`)
  console.log(`今回の更新対象件数        : ${toUpdate.length}（解決できたもののみ）`)
  console.log(`  - dealerCode 解決       : ${resolved}`)
  console.log(`解決不能でスキップ        : ${failedEntries.length}`)
  console.log(`  - Bカート側に該当なし   : ${unresolvedNoBcartMatch}（update しない）`)
  console.log(`  - Bカート側に parent なし: ${unresolvedNoParent}（update しない）`)
  if (writeErrors.length > 0) {
    console.log(`書き込み失敗              : ${writeErrors.length}`)
  }
  if (RE_RESOLVE) {
    console.log(`  - 再解決で値が変わる件数: ${changedByReResolve}`)
  }
  console.log('')

  if (unresolvedCompaniesSorted.length > 0) {
    console.log('=== 未解決 companyName Top 20（orders 件数順） ===')
    unresolvedCompaniesSorted.slice(0, 20).forEach((c, i) => {
      console.log(`  ${(i + 1).toString().padStart(2, ' ')}. ${c.orderCount.toString().padStart(4, ' ')} 件  ${c.companyName}`)
    })
    if (unresolvedCompaniesSorted.length > 20) {
      console.log(`  ...他 ${unresolvedCompaniesSorted.length - 20} 社（フル一覧は JSON ファイル参照）`)
    }
    console.log('')
  }

  if (logFile) {
    console.log(`📁 未解決ログファイル: ${logFile}`)
  }

  console.log('')
  if (DRY_RUN) {
    console.log('🟡 DRY RUN モードでした。実際には書き込んでいません。')
    console.log('   本番実行は: DRY_RUN=false node scripts/backfill-dealer-code.mjs')
  } else {
    console.log(`🟢 本番実行完了: ${toUpdate.length} 件の orders を更新しました。`)
    if (totalFailed > 0) {
      console.log(`⚠️  ${totalFailed} 件は解決不能/書き込み失敗で更新していません。`)
      console.log(`   Firestore ordersBackfillLogs の failedEntries から orderId を確認し、`)
      console.log(`   Bカート側 or companyName を見直してから再実行してください。`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ エラー:', e)
    process.exit(1)
  })
