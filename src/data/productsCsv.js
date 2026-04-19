// Bカート 商品CSV → products.js 構造へのマッパー
//
// CSV 列仕様（UTF-8, ヘッダー必須）:
//   code, name, category, unit, price, badge,
//   short_desc, description, features, usage, tagline,
//   image_url, display_order, is_public
//
// - features は '|' 区切り文字列（例: "A|B|C"）→ 配列
// - is_public が "0" "false" "非公開" の場合は除外対象（isPublic=false）
// - code をキーに slug / categoryKey / gradient を派生
//
// 本ファイルは Node（scripts/）と ブラウザ（Vite）両方からインポート可能。

import {
  CATEGORY_KEY_MAP,
  CATEGORY_GRADIENT_MAP,
  toCategoryKey,
  toSlug,
  gradientFor,
} from './products.js'

export const CSV_COLUMNS = [
  'code',
  'slug',       // optional: 空なら code から自動生成
  'name',
  'category',
  'unit',
  'price',
  'badge',
  'short_desc',
  'description',
  'features',
  'usage',
  'tagline',
  'image_url',
  'display_order',
  'is_public',
]

// CSV 1行をパースして配列に（ダブルクォート内のカンマ・改行対応の簡易実装）
// RFC4180 準拠を目指すが、用途は Bカート/Excel 出力想定で十分な精度。
export function parseCsv(text) {
  if (!text) return []
  const rows = []
  let cur = []
  let field = ''
  let inQuote = false
  let i = 0
  const src = text.replace(/^\uFEFF/, '') // BOM 除去

  while (i < src.length) {
    const ch = src[i]
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuote = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') { inQuote = true; i++; continue }
    if (ch === ',') { cur.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') {
      cur.push(field)
      rows.push(cur)
      cur = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }
  // 末尾
  if (field.length > 0 || cur.length > 0) {
    cur.push(field)
    rows.push(cur)
  }
  // 空行除去
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

function isPublicFlag(v) {
  if (v == null || v === '') return true // 空は公開扱い
  const s = String(v).trim().toLowerCase()
  return !(s === '0' || s === 'false' || s === '非公開' || s === 'no')
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * CSV テキスト → products.js 互換のレコード配列
 * @param {string} csvText
 * @param {{ includeUnpublished?: boolean }} options
 * @returns {{ products: Array, skipped: Array, errors: Array }}
 */
export function parseProductsCsv(csvText, options = {}) {
  const { includeUnpublished = false } = options
  const rows = parseCsv(csvText)
  if (rows.length === 0) {
    return { products: [], skipped: [], errors: ['CSV が空です'] }
  }

  const header = rows[0].map((h) => h.trim())
  const errors = []
  // 必須列チェック
  const required = ['code', 'name', 'category']
  for (const r of required) {
    if (!header.includes(r)) errors.push(`必須列 "${r}" が見つかりません`)
  }
  if (errors.length > 0) {
    return { products: [], skipped: [], errors }
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  const products = []
  const skipped = []

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every((c) => c === '')) continue

    const get = (col) => (idx[col] != null ? (row[idx[col]] ?? '') : '')
    const code = String(get('code') || '').trim()
    const name = String(get('name') || '').trim()

    if (!code || !name) {
      skipped.push({ line: r + 1, reason: 'code/name が空', row })
      continue
    }

    const pub = isPublicFlag(get('is_public'))
    if (!pub && !includeUnpublished) {
      skipped.push({ line: r + 1, reason: '非公開', row })
      continue
    }

    const category = String(get('category') || '').trim()
    const categoryKey = toCategoryKey(category)
    const featuresRaw = String(get('features') || '').trim()
    const features = featuresRaw
      ? featuresRaw.split('|').map((f) => f.trim()).filter(Boolean)
      : []

    const slugRaw = String(get('slug') || '').trim()
    const slug = slugRaw ? toSlug(slugRaw) : toSlug(code)

    products.push({
      slug,
      code,
      name,
      category: category || 'その他',
      categoryKey,
      badge: String(get('badge') || '').trim() || null,
      unit: String(get('unit') || '').trim() || null,
      price: toNumberOrNull(get('price')),
      tagline: String(get('tagline') || '').trim() || null,
      shortDesc: String(get('short_desc') || '').trim(),
      description: String(get('description') || '').trim(),
      features,
      usage: String(get('usage') || '').trim() || null,
      image: String(get('image_url') || '').trim() || null,
      gradient: gradientFor(categoryKey),
      displayOrder: toNumberOrNull(get('display_order')) ?? 9999,
      isPublic: pub,
    })
  }

  // 表示順でソート
  products.sort((a, b) => a.displayOrder - b.displayOrder)

  return { products, skipped, errors: [] }
}

// 単体テスト用エクスポート
export const __test = {
  parseCsv,
  isPublicFlag,
  toNumberOrNull,
  CATEGORY_KEY_MAP,
  CATEGORY_GRADIENT_MAP,
}
