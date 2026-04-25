// functions/lib/emailValidation.js
// SendGrid 経由のメール送信 Function 群で共通利用するアドレス検証ユーティリティ。
//
// 設計方針:
// - sendInvoice / 将来の sendEmailCampaign / receiveInboundEmail などで共通利用
//   するため、特定 Function に依存しない純関数として抽出。
// - クライアント側にも同等ロジックがある（src/lib/emailValidation.js）。
//   regex / パース仕様を一致させること（ズレるとサーバー側だけで弾かれて UX 劣化）。
// - メール形式は緩めに「@ を含み、ドメイン部にドットがあること」のみ確認。
//   完全な RFC 準拠は SendGrid 側に委ねる（厳格すぎると正常アドレスを弾く）。

// 1行の入力（"a@b.com, c@d.com" や "a@b.com; c@d.com"）を配列に分解
function parseAddresses(input) {
  if (!input || typeof input !== 'string') return []
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(addr) {
  return typeof addr === 'string' && EMAIL_RE.test(addr.trim())
}

// 検証結果を返す。invalid フィールドに最初に弾いたアドレスを入れる。
// addresses が空配列の場合は { valid: true, addresses: [] } を返す（呼び出し側で
// 必須チェックは別途行う）。
function validateAddressList(input) {
  const addresses = parseAddresses(input)
  for (const a of addresses) {
    if (!isValidEmail(a)) {
      return { valid: false, addresses, invalid: a }
    }
  }
  return { valid: true, addresses }
}

module.exports = {
  parseAddresses,
  isValidEmail,
  validateAddressList,
  EMAIL_RE,
}
