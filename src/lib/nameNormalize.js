/**
 * companyName 表記揺れ吸収のための正規化ヘルパー（共通）
 *
 * ## 目的
 *   同一サロンが大小文字や余分なスペースの違いで「別サロン」として
 *   集計されるのを防ぐ。
 *
 * ## ポリシー（社長承認・2026-04-23）
 *   - Firestore の実データは書き換えない（このヘルパーは集計・表示時のみ使う）
 *   - normalizeCompanyName は「集計用キー」を返す。表示には使わない。
 *   - 表示には pickDisplayName で「件数最大のバリアント」を採用する。
 *
 * ## 検出済みの衝突パターン（2026-04-23 production 調査）
 *   "Salon'de  A" / "salon'de  A"
 *   "LUANA" / "Luana"
 *   "hair make Macaron" / "hair make macaron"
 *   "Nicote" / "nicote"
 *   "Welina" / "welina"
 *   "ViVi" / "vivi"
 *   いずれも大小文字差のみ。空白幅の差は今回データでは未検出だが、
 *   将来の入力ブレに備えて NFKC + 空白圧縮も入れておく。
 */

/**
 * 集計用の正規化キーを返す。
 *
 * 順序:
 *   1. NFKC（全角英数→半角 / 半角カナ→全角カナ）
 *   2. trim（前後空白除去）
 *   3. 連続空白（半角/全角/タブ/改行）を半角1個に圧縮
 *   4. toLowerCase
 *
 * @param {string|null|undefined} name
 * @returns {string} 正規化キー（空入力は ''）
 */
export function normalizeCompanyName(name) {
  if (!name) return ''
  return String(name)
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u3000]+/g, ' ')
    .toLowerCase()
}

/**
 * 同一正規化キーに集まったバリアント群から、表示用の代表名を選ぶ。
 *
 * 優先順位:
 *   1. 件数最大のバリアント
 *   2. 同票なら先勝ち
 *
 * @param {Iterable<[string, number]> | Iterable<string>} variants
 *   - [name, count] のペア配列、もしくは name 文字列の配列
 * @returns {string} 代表名（空入力は ''）
 */
export function pickDisplayName(variants) {
  let best = ''
  let bestCount = -1
  for (const v of variants) {
    if (Array.isArray(v)) {
      const [name, count] = v
      const c = Number(count) || 0
      if (c > bestCount) {
        best = String(name || '')
        bestCount = c
      }
    } else {
      if (bestCount < 0) {
        best = String(v || '')
        bestCount = 0
      }
    }
  }
  return best
}
