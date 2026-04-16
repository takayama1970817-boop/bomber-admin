// Bカート受注通知メール パーサー
// 対応する揺れ:
//   - 部署名あり/なし
//   - 携帯番号が電話番号と同一の場合
//   - 品番（JAN）空OK（キャンペーン品対応）
//   - 入数の単位「個/セット/本/mL等」混在
//   - セット名 = キャンペーン名（例: "ミカエル"）
//   - 決済方法の揺れ（"クレジットカード決済" / "Paid" 等）
//   - 「お客様からの連絡事項」セクション（任意）

const pick = (text, key) => {
  // "key：value" または "key:value" を拾う。行末まで。
  const re = new RegExp(
    `${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:]\\s*(.*)`,
  )
  const m = text.match(re)
  return m ? m[1].trim() : ''
}

const yen = (s) => {
  if (!s) return 0
  const n = s.replace(/[^\d]/g, '')
  return n ? parseInt(n, 10) : 0
}

const stripSama = (s) => s.replace(/\s*様\s*$/, '').trim()

export function parseBcartEmail(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('メール本文が空です')
  }

  const text = rawText.replace(/\r\n/g, '\n')

  // --- お客様情報 ---
  const company = pick(text, '会社名')
  if (!company) {
    throw new Error(
      '会社名が見つかりません。Bカートの受注通知メールではない可能性があります。',
    )
  }
  const department = pick(text, '部署名')
  const contact = stripSama(pick(text, '担当者'))
  const zip = pick(text, '郵便番号')
  const address = pick(text, '住所')
  const email = pick(text, 'メールアドレス')
  const phone = pick(text, '電話番号')
  const mobileRaw = pick(text, '携帯番号')
  // 携帯が電話と同じなら重複保存しない
  const mobile = mobileRaw && mobileRaw !== phone ? mobileRaw : ''

  // --- 注文情報 ---
  const orderNumber = pick(text, '注文番号')
  if (!orderNumber) {
    throw new Error('注文番号が見つかりません')
  }
  const orderDateStr = pick(text, '注文日時')
  const paymentMethod = pick(text, '決済方法')
  const subtotal = yen(pick(text, '商品総額'))
  const shipping = yen(pick(text, '送料'))
  const total = yen(pick(text, '注文総額'))

  // 消費税は「うち消費税 X,XXX円」から抽出
  let tax = 0
  const taxMatch = text.match(/うち消費税\s*([\d,]+)\s*円/)
  if (taxMatch) tax = yen(taxMatch[1])

  // 注文日時パース "2026-04-10 00:38:23" → Date
  let orderDate = null
  if (orderDateStr) {
    const m = orderDateStr.match(
      /(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/,
    )
    if (m) {
      orderDate = new Date(
        parseInt(m[1], 10),
        parseInt(m[2], 10) - 1,
        parseInt(m[3], 10),
        parseInt(m[4], 10),
        parseInt(m[5], 10),
        parseInt(m[6], 10),
      )
    }
  }
  if (!orderDate || Number.isNaN(orderDate.getTime())) {
    throw new Error('注文日時が解析できませんでした')
  }

  // --- 商品明細 ---
  // [商品N] でブロック分割
  const blocks = text.split(/\[商品\d+\]/).slice(1)
  const items = blocks
    .map((block) => {
      // 次のセクション（━━━で始まる区切り）で切る
      const stopIdx = block.search(/━━━/)
      const chunk = stopIdx >= 0 ? block.slice(0, stopIdx) : block

      const name = pick(chunk, '商品名')
      const setName = pick(chunk, 'セット名')
      const sku = pick(chunk, '品番')
      const unitStr = pick(chunk, '入数')
      const price = yen(pick(chunk, '単価'))
      const qty = parseInt(pick(chunk, '注文数') || '0', 10) || 0
      const itemSubtotal = yen(pick(chunk, '小計'))

      return {
        name,
        campaign: setName || '',
        sku,
        unit: unitStr,
        price,
        qty,
        subtotal: itemSubtotal,
      }
    })
    .filter((it) => it.name)

  if (items.length === 0) {
    throw new Error('商品明細が見つかりませんでした')
  }

  // 全商品のセット名が同じならオーダー全体の campaign とする
  const campaigns = [...new Set(items.map((it) => it.campaign).filter(Boolean))]
  const orderCampaign = campaigns.length === 1 ? campaigns[0] : ''

  // お客様からの連絡事項（任意）
  let customerNote = ''
  const noteMatch = text.match(
    /お客様からの連絡事項[\s\S]*?━+\s*\n([\s\S]*?)(?:\n\n|$)/,
  )
  if (noteMatch) {
    customerNote = noteMatch[1].trim()
  }

  return {
    customer: {
      companyName: company,
      department,
      contact,
      zip,
      address,
      email,
      phone,
      mobile,
    },
    order: {
      orderNumber,
      orderDate,
      paymentMethod,
      subtotal,
      shipping,
      total,
      tax,
      campaign: orderCampaign,
      customerNote,
    },
    items,
  }
}
