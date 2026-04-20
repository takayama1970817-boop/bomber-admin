/**
 * Firestore 日次バックアップ
 *
 * 毎日 03:00 JST に全コレクションを GCS へ export する
 * bucket: bomber-admin-firestore-backup-prod
 * path:   gs://bomber-admin-firestore-backup-prod/firestore-exports/YYYY-MM-DD/
 *
 * エラー時のみ Slack 通知（SLACK_WEBHOOK_URL を環境変数で設定）
 */
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { logger } = require('firebase-functions/v2')
const { defineSecret } = require('firebase-functions/params')
const { GoogleAuth } = require('google-auth-library')

const SLACK_WEBHOOK_URL = defineSecret('SLACK_WEBHOOK_URL')

const PROJECT_ID = 'bomber-admin-prod'
const BACKUP_BUCKET = 'bomber-admin-firestore-backup-prod'
const BACKUP_PREFIX = 'firestore-exports'

// ---- Slack 通知（エラー時のみ） ----
async function notifySlack(message) {
  const webhook = SLACK_WEBHOOK_URL.value() || process.env.SLACK_WEBHOOK_URL
  if (!webhook) {
    logger.warn('SLACK_WEBHOOK_URL が未設定のため通知をスキップ')
    return
  }
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 *Firestoreバックアップ失敗*\n${message}`,
      }),
    })
  } catch (e) {
    logger.error('Slack通知失敗', e)
  }
}

// ---- 日付文字列（JST） ----
function todayJst() {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear()
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(jst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 日次 export（全コレクション対象）
 * schedule: 毎日 03:00 JST
 * timeoutSeconds: 540（9分）
 */
exports.scheduledFirestoreBackup = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Tokyo',
    timeoutSeconds: 540,
    memory: '512MiB',
    region: 'asia-northeast1',
    retryCount: 2,
    secrets: [SLACK_WEBHOOK_URL],
  },
  async () => {
    const dateStr = todayJst()
    const outputUriPrefix = `gs://${BACKUP_BUCKET}/${BACKUP_PREFIX}/${dateStr}`

    logger.info('Firestore export 開始', { outputUriPrefix })

    try {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/datastore'],
      })
      const client = await auth.getClient()
      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default):exportDocuments`

      const res = await client.request({
        url,
        method: 'POST',
        data: {
          outputUriPrefix,
          // collectionIds を空にすると全コレクション対象
        },
      })

      logger.info('Firestore export 起動成功', {
        operationName: res.data.name,
        outputUriPrefix,
      })
      // 注: exportDocuments は LRO。起動成功＝キックオフ成功。
      // 完了監視は GCS にファイルが出ているかで確認する運用。
    } catch (error) {
      const msg = `export 起動失敗: ${error.message}\nproject=${PROJECT_ID}\nbucket=${BACKUP_BUCKET}`
      logger.error('Firestore export 失敗', error)
      await notifySlack(msg)
      throw error
    }
  }
)

/**
 * 古いバックアップ削除（30日経過分）
 * schedule: 毎日 04:00 JST
 */
exports.cleanupOldBackups = onSchedule(
  {
    schedule: '0 4 * * *',
    timeZone: 'Asia/Tokyo',
    timeoutSeconds: 300,
    memory: '256MiB',
    region: 'asia-northeast1',
    secrets: [SLACK_WEBHOOK_URL],
  },
  async () => {
    const { Storage } = require('@google-cloud/storage')
    const storage = new Storage()
    const bucket = storage.bucket(BACKUP_BUCKET)

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    try {
      // live オブジェクトのみ対象。削除済み旧バージョンはライフサイクルに任せる
      const [files] = await bucket.getFiles({
        prefix: BACKUP_PREFIX + '/',
        versions: false,
      })
      let deleted = 0
      let skipped = 0
      for (const file of files) {
        try {
          const [metadata] = await file.getMetadata()
          const updated = new Date(metadata.updated)
          if (updated < cutoff) {
            // ignoreNotFound で冪等化（ライフサイクルが先に消してもOK）
            await file.delete({ ignoreNotFound: true })
            deleted++
          }
        } catch (e) {
          // 個別ファイルのエラーは全体を止めない
          if (e.code === 404) { skipped++; continue }
          logger.warn(`個別削除失敗: ${file.name}`, e.message)
          skipped++
        }
      }
      logger.info(`削除: ${deleted}件 / スキップ: ${skipped}件（ライフサイクル二重化）`)
    } catch (error) {
      const msg = `古いバックアップ削除失敗: ${error.message}`
      logger.error(msg, error)
      await notifySlack(msg)
      throw error
    }
  }
)
