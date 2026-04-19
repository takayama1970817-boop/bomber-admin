/**
 * Bカート商品CSV → src/data/productsGenerated.js 生成スクリプト
 *
 * 使い方:
 *   node scripts/import-products-csv.mjs <CSVパス> [--include-unpublished]
 *
 * 例:
 *   node scripts/import-products-csv.mjs ./docs/bcart-products-sample.csv
 *
 * 出力:
 *   src/data/productsGenerated.js  ← 公開ページから参照（Phase 2-3）
 *
 * Phase 2-4 で bcart-sync.mjs に Bカート API 直取得を統合予定。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseProductsCsv } from '../src/data/productsCsv.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const args = process.argv.slice(2)
const includeUnpublished = args.includes('--include-unpublished')
const csvPath = args.find((a) => !a.startsWith('--'))

if (!csvPath) {
  console.error('使い方: node scripts/import-products-csv.mjs <CSVパス> [--include-unpublished]')
  process.exit(1)
}

const absCsv = resolve(process.cwd(), csvPath)
if (!existsSync(absCsv)) {
  console.error(`CSV が見つかりません: ${absCsv}`)
  process.exit(1)
}

console.log(`=== Bカート商品CSV 取込 ===`)
console.log(`入力: ${absCsv}`)
console.log(`非公開を含む: ${includeUnpublished ? 'YES' : 'NO'}`)

const csvText = readFileSync(absCsv, 'utf-8')
const { products, skipped, errors } = parseProductsCsv(csvText, { includeUnpublished })

if (errors.length > 0) {
  console.error('\nエラー:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log(`\n解析結果:`)
console.log(`  取込: ${products.length} 件`)
console.log(`  スキップ: ${skipped.length} 件`)
if (skipped.length > 0) {
  skipped.forEach((s) => console.log(`    L${s.line}: ${s.reason}`))
}

// src/data/productsGenerated.js に書き出し
const outPath = resolve(__dirname, '..', 'src', 'data', 'productsGenerated.js')
const header = `// ⚠️ 自動生成ファイル — scripts/import-products-csv.mjs で上書きされます
// 手動編集しないでください（カテゴリ辞書の拡張は src/data/products.js を編集）

`
const body = `export const generatedProducts = ${JSON.stringify(products, null, 2)}\n\nexport const generatedAt = ${JSON.stringify(new Date().toISOString())}\n`
writeFileSync(outPath, header + body, 'utf-8')

console.log(`\n出力: ${outPath}`)
console.log('完了')
