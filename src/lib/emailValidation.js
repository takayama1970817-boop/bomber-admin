// src/lib/emailValidation.js
// クライアント側のメールアドレス検証ユーティリティ。
// functions/lib/emailValidation.js とロジックを一致させること
// （ズレるとサーバー側だけで弾かれて UX 劣化する）。
//
// 用途: InvoiceSendModal の送信ボタン制御、将来のメルマガUI など。

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseAddresses(input) {
  if (!input || typeof input !== 'string') return []
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isValidEmail(addr) {
  return typeof addr === 'string' && EMAIL_RE.test(addr.trim())
}

// 入力を検証して { valid, addresses, invalid } を返す。
// 空入力は { valid: true, addresses: [] }（呼び出し側で必須判定）。
export function validateAddressList(input) {
  const addresses = parseAddresses(input)
  for (const a of addresses) {
    if (!isValidEmail(a)) {
      return { valid: false, addresses, invalid: a }
    }
  }
  return { valid: true, addresses }
}
