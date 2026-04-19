#!/usr/bin/env node
/**
 * 復旧訓練ログのチェックスクリプト（厳格版）
 *
 * チェック項目:
 *   1. 前月の YYYY-MM エントリが存在するか
 *   2. 必須フィールドに具体値が入っているか（担当/実施日/シナリオ結果/所要時間 等）
 *   3. サンプル値（sample, サンプル, TBD, XX, - など）で埋められていないか
 *
 * 使い方:
 *   node scripts/backup/check-drill-log.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const LOG_PATH = resolve(process.cwd(), 'docs/backup-drill-log.md')
// 初回運用期間中は 25（定着後に 10 へ戻す）
// 変更時は docs/backup-operations.md の「初回運用時だけ変更する設定」も更新すること
const GRACE_DAYS = 25

// サンプル値・プレースホルダと判定される文字列
const PLACEHOLDER_PATTERNS = [
  /^sample$/i,
  /^サンプル$/,
  /^tbd$/i,
  /^未定$/,
  /^-+$/,
  /^x+$/i, // XX, XXX
  /^xx\.?x?%?$/i, // XX.X%, XX%
  /^\d+x+$/i, // 123XX
  /^(yyyy|mmmm|dddd)/i,
]

// 必須フィールドと、その値パターン
// key: ラベル, pattern: 値を抽出する正規表現, validator: 値が妥当か判定
const REQUIRED_FIELDS = [
  {
    label: '担当',
    pattern: /^-\s*担当\s*[:：]\s*(.+)$/m,
    validator: (v) => v.length >= 2,
  },
  {
    label: '開始/終了',
    pattern: /^-\s*開始\/終了\s*[:：]\s*(.+)$/m,
    validator: (v) => /\d/.test(v),
  },
  {
    label: 'シナリオ1',
    pattern: /^-\s*シナリオ1[^:：]*[:：]\s*(.+)$/m,
    validator: (v) => /(OK|NG)/.test(v),
  },
  {
    label: 'シナリオ2',
    pattern: /^-\s*シナリオ2[^:：]*[:：]\s*(.+)$/m,
    validator: (v) => /(OK|NG)/.test(v),
  },
  {
    label: 'シナリオ3',
    pattern: /^-\s*シナリオ3[^:：]*[:：]\s*(.+)$/m,
    validator: (v) => /(OK|NG)/.test(v),
  },
  {
    label: '所要時間',
    pattern: /^-\s*所要時間\s*[:：]\s*(.+)$/m,
    validator: (v) => /\d/.test(v),
  },
  {
    label: '本番件数',
    pattern: /^-\s*本番件数\s*[:：]\s*(.+)$/m,
    validator: (v) => /\d/.test(v),
  },
  {
    label: '復旧先件数',
    pattern: /^-\s*復旧先件数\s*[:：]\s*(.+)$/m,
    validator: (v) => /\d/.test(v),
  },
]

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
function warn(msg) {
  console.warn(`⚠️  ${msg}`)
}
function ok(msg) {
  console.log(`✅ ${msg}`)
}

function isPlaceholder(value) {
  const trimmed = value.trim()
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))
}

// ===== メイン =====
if (!existsSync(LOG_PATH)) {
  fail(`訓練ログが存在しません: ${LOG_PATH}`)
}

const content = readFileSync(LOG_PATH, 'utf-8')

// 前月の YYYY-MM
const now = new Date()
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
const lastYm = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`

// 見出し検出
const headingRe = new RegExp(`^##\\s+${lastYm}-\\d{2}\\s+訓練`, 'm')
const hasEntry = headingRe.test(content)

const dayOfMonth = now.getDate()
const withinGrace = dayOfMonth <= GRACE_DAYS

if (!hasEntry) {
  if (withinGrace) {
    warn(`${lastYm} の訓練ログが未記入（猶予期間内: 月初${GRACE_DAYS}日まで）`)
    warn(`${GRACE_DAYS + 1}日以降、このチェックはエラーになります`)
    process.exit(0)
  }
  fail(
    `${lastYm} の訓練ログが未記入です。docs/backup-drill-log.md に前月分を記入してください。`
  )
}

// エントリ本体抽出
const entryRe = new RegExp(
  `##\\s+${lastYm}-\\d{2}\\s+訓練([\\s\\S]*?)(?:\\n##\\s|$)`
)
const match = content.match(entryRe)
if (!match) {
  fail(`${lastYm} の訓練ログエントリを読み取れませんでした`)
}
const entry = match[1]

// ---- 必須フィールドの具体値チェック ----
const errors = []
const warnings = []

for (const field of REQUIRED_FIELDS) {
  const m = entry.match(field.pattern)
  if (!m) {
    errors.push(`必須項目「${field.label}」が記入されていません`)
    continue
  }
  const value = m[1].trim()

  // 空
  if (!value) {
    errors.push(`「${field.label}」が空です`)
    continue
  }

  // プレースホルダ
  if (isPlaceholder(value)) {
    errors.push(`「${field.label}」がプレースホルダ値のままです: "${value}"`)
    continue
  }

  // カスタムバリデータ
  if (!field.validator(value)) {
    errors.push(`「${field.label}」の値が不正: "${value}"`)
    continue
  }
}

// ---- エントリ全体のサンプル文字列検出 ----
const globalPlaceholders = ['sample', 'サンプル', 'TBD', '未記入']
for (const p of globalPlaceholders) {
  if (entry.toLowerCase().includes(p.toLowerCase())) {
    errors.push(`エントリ内にプレースホルダ文字列 "${p}" が残っています`)
  }
}

// ---- OK/NG 件数 ----
const ngCount = (entry.match(/\bNG\b/g) || []).length
const okCount = (entry.match(/\bOK\b/g) || []).length
if (okCount === 0) {
  errors.push('"OK" の記載がありません（シナリオ結果未記入）')
}
if (ngCount > 0) {
  warnings.push(`訓練で NG が ${ngCount} 件あります。改善対応を確認してください`)
}

// ---- 結果 ----
if (errors.length > 0) {
  console.error(`❌ ${lastYm} の訓練ログに問題があります:`)
  errors.forEach((e) => console.error(`   - ${e}`))
  process.exit(1)
}

warnings.forEach((w) => warn(w))
ok(`${lastYm} の訓練ログ記載を確認: OK ${okCount}件 / NG ${ngCount}件 / 必須項目 ${REQUIRED_FIELDS.length}件すべて具体値OK`)
