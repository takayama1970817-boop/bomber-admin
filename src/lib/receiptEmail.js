// 領収書メール生成ヘルパー
// parsed（Bカートメール解析結果）から、Gmail の下書きURLを生成する
// クリックすると Gmail の作成画面が新タブで開き、宛先・件名・本文が自動入力される

// 発行元情報（必要に応じて書き換え）
const ISSUER = {
  name: 'ロイヤルトラスト株式会社',
  zip: '150-0012',
  address: '東京都渋谷区広尾5-24-3',
  tel: '03-3441-7839',
  url: 'http://royaltrust.jp/',
  invoiceNo: 'T5120001125556',
}

// 領収書キーワード検出
export function hasReceiptRequest(customerNote) {
  if (!customerNote) return false
  return /領収書|領収証|レシート/.test(customerNote)
}

const yen = (n) => '¥' + (n ?? 0).toLocaleString('ja-JP')

const fmtDate = (d) => {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`
}

// parsed → 領収書メール本文（プレーンテキスト）
export function buildReceiptBody(parsed) {
  const { customer, order } = parsed
  const issueDate = fmtDate(new Date())
  const orderDate = fmtDate(order.orderDate)

  const addressee = customer.contact
    ? `${customer.companyName}\n${customer.contact} 様`
    : `${customer.companyName} 御中`

  // 送料行は0円時に非表示
  const shippingLine =
    order.shipping > 0 ? `送料　　　　　　： ${yen(order.shipping)}\n` : ''

  return `${addressee}

いつもお世話になっております。
${ISSUER.name}でございます。

この度はご注文いただき誠にありがとうございます。
下記の通り領収書を発行いたしますので、ご査収くださいますようお願い申し上げます。
詳細は添付の PDF 領収書をご確認ください。

━━━━━━━━ 領 収 書 ━━━━━━━━

発行日　　　： ${issueDate}
注文番号　　： ${order.orderNumber}
ご注文日　　： ${orderDate}

宛名　　　　： ${customer.companyName} 様

金額　　　　： ${yen(order.total)}（税込）
　　　　　　　（うち消費税 ${yen(order.tax)}）

但し書き　　： 商品代金として

上記正に領収いたしました。

━━━━━━━━ 内 訳 ━━━━━━━━

商品合計（税抜）： ${yen(order.subtotal)}
${shippingLine}10%対象 消費税　： ${yen(order.tax)}
──────────────
合計（税込）　　： ${yen(order.total)}

━━━━━━━━ 発 行 元 ━━━━━━━━

${ISSUER.name}
〒${ISSUER.zip} ${ISSUER.address}
TEL： ${ISSUER.tel}
URL： ${ISSUER.url}

適格請求書発行事業者 登録番号： ${ISSUER.invoiceNo}

※ 本メールは電子領収書として発行しております。
※ 電子取引のため、収入印紙の貼付は不要です（印紙税法上、電子データでの発行は課税文書に該当しないため）。

ご不明な点がございましたら、お気軽にお問い合わせください。
今後ともよろしくお願い申し上げます。
`
}

// Gmail 下書きURL生成
// https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...
export function buildGmailComposeUrl(parsed) {
  const to = parsed.customer.email || ''
  const subject = `【${ISSUER.name}】領収書発行のご連絡（注文番号: ${parsed.order.orderNumber}）`
  const body = buildReceiptBody(parsed)

  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to,
    su: subject,
    body,
  })
  return `https://mail.google.com/mail/?${params.toString()}`
}
