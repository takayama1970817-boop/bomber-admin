const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore } = require('firebase-admin/firestore')
const fetch = require('node-fetch')

initializeApp()

/**
 * Bカート在庫同期 Callable Function
 *
 * パラメータ:
 * - domain: string (e.g., "myshop" for https://myshop.bcart.jp/)
 * - apikey: string (Bearer token for Bカート API)
 * - items: array of { code, bcart_id, stock, name, is_low }
 * - threshold: number (在庫数がこれ以下の場合、stock_display: 'few'に設定)
 * - mapping: 'code' | 'bcart_id' (商品特定の方法)
 *
 * 戻り値:
 * {
 *   success: number (同期成功した件数)
 *   failed: number (失敗した件数)
 *   low_stock: number (在庫が閾値以下で'few'に設定した件数)
 *   skipped: number (スキップした件数)
 *   results: array of {
 *     code: string,
 *     name: string,
 *     status: 'success' | 'failed' | 'skipped',
 *     is_low: boolean,
 *     error: string | null
 *   }
 * }
 */
exports.syncBcartInventory = onCall(
  { region: 'asia-northeast1', timeoutSeconds: 540 },
  async (request) => {
    // 認証チェック
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'ログインが必要です')
    }

    // 管理者権限チェック
    const db = getFirestore()
    const callerDoc = await db.collection('users').doc(request.auth.uid).get()
    if (!callerDoc.exists || !['admin', 'master'].includes(callerDoc.data().role)) {
      throw new HttpsError('permission-denied', '管理者権限が必要です')
    }

    const { domain, apikey, items, threshold, mapping } = request.data

    // バリデーション
    if (!domain || !apikey || !items || !Array.isArray(items)) {
      throw new HttpsError('invalid-argument', 'domain, apikey, items(array) が必要です')
    }
    if (typeof threshold !== 'number' || threshold < 0) {
      throw new HttpsError('invalid-argument', 'threshold は0以上の数値が必要です')
    }
    if (!['code', 'bcart_id'].includes(mapping)) {
      throw new HttpsError('invalid-argument', 'mapping は "code" または "bcart_id" である必要があります')
    }

    const baseUrl = `https://${domain}.bcart.jp/api/v1`
    const results = []
    let successCount = 0
    let failedCount = 0
    let lowStockCount = 0
    let skippedCount = 0

    // レート制限: 300リクエスト/300秒 = 100msごとに1リクエスト
    const rateLimitDelayMs = 100

    /**
     * HTTP GETリクエスト（レート制限付き）
     */
    const get = async (endpoint, params = {}) => {
      await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs))

      const url = new URL(`${baseUrl}${endpoint}`)
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, value)
        }
      })

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apikey}`,
          'Content-Type': 'application/json',
        },
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Bカート API エラー (${res.status}): ${errorText}`)
      }

      return await res.json()
    }

    /**
     * HTTP PUTリクエスト（レート制限付き）
     */
    const put = async (endpoint, body) => {
      await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs))

      const url = `${baseUrl}${endpoint}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apikey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Bカート API エラー (${res.status}): ${errorText}`)
      }

      return await res.json()
    }

    /**
     * 各商品の在庫を同期
     */
    for (const item of items) {
      const { code, bcart_id, stock, name, is_low: itemIsLow } = item

      try {
        let productId = bcart_id

        // mapping: 'code' の場合、商品検索で product_id を取得
        if (mapping === 'code') {
          if (!code) {
            results.push({
              code: code || '(unknown)',
              name: name || '(unknown)',
              status: 'skipped',
              is_low: false,
              error: 'code が指定されていません',
            })
            skippedCount++
            continue
          }

          try {
            const searchRes = await get('/products', { product_code: code })
            if (!searchRes.data || !Array.isArray(searchRes.data) || searchRes.data.length === 0) {
              results.push({
                code,
                name: name || '(unknown)',
                status: 'skipped',
                is_low: false,
                error: `品番 "${code}" に対応する商品が見つかりません`,
              })
              skippedCount++
              continue
            }
            productId = searchRes.data[0].id
          } catch (e) {
            results.push({
              code,
              name: name || '(unknown)',
              status: 'failed',
              is_low: false,
              error: `商品検索エラー: ${e.message}`,
            })
            failedCount++
            continue
          }
        }

        if (!productId) {
          results.push({
            code: code || '(unknown)',
            name: name || '(unknown)',
            status: 'skipped',
            is_low: false,
            error: '商品IDが特定できません',
          })
          skippedCount++
          continue
        }

        // 在庫数を更新
        const updateBody = { stock_quantity: stock }
        const isLow = stock <= threshold

        // 在庫が閾値以下の場合、表示ステータスを 'few' に
        if (isLow) {
          updateBody.stock_display = 'few'
        }

        await put(`/products/${productId}`, updateBody)

        results.push({
          code: code || bcart_id,
          name: name || '(unknown)',
          status: 'success',
          is_low: isLow,
          error: null,
        })

        successCount++
        if (isLow) {
          lowStockCount++
        }
      } catch (e) {
        results.push({
          code: code || bcart_id || '(unknown)',
          name: name || '(unknown)',
          status: 'failed',
          is_low: false,
          error: e.message,
        })
        failedCount++
      }
    }

    return {
      success: successCount,
      failed: failedCount,
      low_stock: lowStockCount,
      skipped: skippedCount,
      results,
    }
  }
)
