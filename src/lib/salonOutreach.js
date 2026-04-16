/**
 * 休眠サロン向け LINE / メルマガ下書き生成
 *
 * テンプレートに変数を差し込み、Gmail 下書き URL or テキストを生成する。
 * VAVITTE ブランド（ボンバークリーム・6+1・ミカエル・エンジェル）対応。
 */

const SIGNATURE_MAIL = `━━━━━━━━━━━━━━━━━━━
ロイヤルトラスト株式会社
VAVITTE（バビッテ）カスタマー担当
TEL: 03-3441-7839
http://royaltrust.jp/
━━━━━━━━━━━━━━━━━━━`

const SIGNATURE_LINE = `✨ VAVITTE カスタマー担当
※ご不明点はこのLINEに直接ご返信ください`

// -----------------------------------------------------
// テンプレート定義
// -----------------------------------------------------
// type: 'mail' | 'line'
// subjectTemplate: メールのみ
// bodyTemplate: 本文
// recommendedFor: どの risk 層向けか（任意）
// 差し込み変数:
//   {salonName}          サロン名
//   {daysSinceLastOrder} 最終発注からの日数
//   {lastOrderDateStr}   最終発注日（yyyy/mm/dd）
//   {ltvStr}             LTV（¥xxx,xxx）
//   {nextRecommended}    おすすめ次アクション（自動生成）

export const OUTREACH_TEMPLATES = [
  // -------- LINE（短文・絵文字あり） --------
  {
    id: 'line_30days_soft',
    label: '【LINE】30日フォロー（柔らかめ）',
    type: 'line',
    recommendedFor: ['watch'],
    bodyTemplate: `{salonName}
担当の◯◯です😊

前回のご注文から{daysSinceLastOrder}日経ちました！
ボンバークリーム、在庫大丈夫ですか？

今月は6+1キャンペーンも継続中なので、
早めのご発注おすすめです✨

何かお困りのことがあればこのまま返信くださいね！

${SIGNATURE_LINE}`,
  },
  {
    id: 'line_60days_push',
    label: '【LINE】60日警告（もう一押し）',
    type: 'line',
    recommendedFor: ['warn'],
    bodyTemplate: `{salonName}
ご無沙汰しております🙏

前回ご注文から{daysSinceLastOrder}日、
VAVITTE商品の在庫・売行きはいかがでしょうか？

現在「ミカエル」セットが好調で、
特別価格でご案内できます🎁
（在庫限り／今月末まで）

ぜひ一度お話できれば嬉しいです。
担当よりお電話させていただいてもよろしいでしょうか？

${SIGNATURE_LINE}`,
  },
  {
    id: 'line_90days_recovery',
    label: '【LINE】90日超 離脱救済（最終アプローチ）',
    type: 'line',
    recommendedFor: ['lost'],
    bodyTemplate: `{salonName}

長らくご連絡できず申し訳ございません🙇‍♀️

最後のご注文から{daysSinceLastOrder}日が経過し、
サロン様の状況が気になっております。

・商品の使用感で気になる点はありませんか？
・お客様への提案で改善したいことは？
・新しい施術メニューのご相談は？

担当より一度ご訪問させていただけますか？
ご都合の良い日を2〜3候補いただければ調整いたします。

${SIGNATURE_LINE}`,
  },

  // -------- メール（少し長め・テンプレ丁寧） --------
  {
    id: 'mail_repurchase_general',
    label: '【メール】再購入促進（汎用）',
    type: 'mail',
    recommendedFor: ['watch', 'warn'],
    subjectTemplate: '【VAVITTE】{salonName}様 ― ボンバークリーム在庫のご確認',
    bodyTemplate: `{salonName} ご担当者様

いつもお世話になっております。
VAVITTE（バビッテ）カスタマー担当です。

前回のご注文（{lastOrderDateStr}）から{daysSinceLastOrder}日が経過しました。
ボンバークリームをはじめとする VAVITTE 商品の在庫状況はいかがでしょうか？

■ 現在ご案内中のキャンペーン
・6+1キャンペーン：6本ご発注で1本プレゼント
・ミカエルセット：人気アイテム組合せの特別価格
・エンジェルセット：新規施術導入セット

お客様への提案・次回発注のご相談など、
お気軽にご返信ください。
担当よりすぐにご連絡いたします。

今後とも VAVITTE をよろしくお願い申し上げます。

${SIGNATURE_MAIL}`,
  },
  {
    id: 'mail_mikael_campaign',
    label: '【メール】ミカエルキャンペーン告知',
    type: 'mail',
    recommendedFor: ['safe', 'watch', 'warn'],
    subjectTemplate: '【VAVITTE】期間限定・ミカエルセット特別ご案内（{salonName}様）',
    bodyTemplate: `{salonName} ご担当者様

いつも VAVITTE をご愛顧いただきありがとうございます。

この度、人気商品を組み合わせた
「ミカエルセット」を特別価格でご案内いたします。

■ セット内容
・ボンバークリーム
・VAVITTE 主力ラインナップ3点
・サロン店販POP一式

■ 特別価格
通常価格より約XX%OFF
※単品販売ではなく「ミカエル」としての一括発注が条件となります

■ 対象期間
{lastOrderDateStr}〜（在庫限り）

{salonName}様のLTV ¥{ltvStr} に見合った特別ご案内です。
ぜひこの機会にご検討ください。

ご発注は本メールへのご返信または担当まで。

${SIGNATURE_MAIL}`,
  },
  {
    id: 'mail_six_plus_one',
    label: '【メール】6+1キャンペーン告知',
    type: 'mail',
    recommendedFor: ['safe', 'watch', 'warn', 'lost'],
    subjectTemplate: '【VAVITTE】ボンバークリーム 6+1キャンペーン（{salonName}様）',
    bodyTemplate: `{salonName} ご担当者様

いつもお世話になっております。
VAVITTE カスタマー担当です。

■ 6+1キャンペーン継続中
ボンバークリームを6本ご発注で、
同商品を1本プレゼントいたします。

サロン店販での利益率UP、
または施術用ストックとして人気の組合せです。

■ ご発注方法
Bカート または 本メールへのご返信

お気軽にご相談ください。

${SIGNATURE_MAIL}`,
  },
  {
    id: 'mail_visit_appoint',
    label: '【メール】訪問アポ依頼',
    type: 'mail',
    recommendedFor: ['warn', 'lost'],
    subjectTemplate: '【VAVITTE】ご訪問日程のご相談（{salonName}様）',
    bodyTemplate: `{salonName} ご担当者様

いつも VAVITTE をご愛顧いただきありがとうございます。

前回のご注文（{lastOrderDateStr}）より{daysSinceLastOrder}日が経過いたしました。
サロン様の現況を直接お伺いしたく、
担当よりご訪問のお時間を頂戴できればと存じます。

■ ご相談内容（例）
・新商品・新施術メニューのご提案
・既存商品の使用感・課題のヒアリング
・店販売上UPのサポート
・次回キャンペーンの先行ご案内

■ お時間
30分〜1時間程度
オンライン（Zoom / Google Meet）でも対応可能です

候補日を2〜3お知らせいただけましたら、
当方より調整ご連絡いたします。

よろしくお願い申し上げます。

${SIGNATURE_MAIL}`,
  },
]

// -----------------------------------------------------
// 変数差し込み
// -----------------------------------------------------
function fmtYen(n) {
  return `${Math.round(n || 0).toLocaleString()}`
}

function fmtDate(d) {
  if (!d) return '（未発注）'
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return '（未発注）'
  return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
}

function interpolate(str, salon) {
  return str
    .replace(/\{salonName\}/g, salon.name || 'サロン')
    .replace(/\{daysSinceLastOrder\}/g, String(salon.daysSinceLastOrder ?? '?'))
    .replace(/\{lastOrderDateStr\}/g, fmtDate(salon.lastOrderDate))
    .replace(/\{ltvStr\}/g, fmtYen(salon.totalRevenue))
    .replace(/\{nextRecommended\}/g, salon.nextAction || '')
}

/**
 * テンプレート + サロン分析データ → 件名・本文
 */
export function renderTemplate(template, salon) {
  return {
    subject: template.subjectTemplate
      ? interpolate(template.subjectTemplate, salon)
      : '',
    body: interpolate(template.bodyTemplate, salon),
    type: template.type,
  }
}

// -----------------------------------------------------
// Gmail 下書き URL
// -----------------------------------------------------
export function buildGmailComposeUrl(salon, template, customBody) {
  const rendered = renderTemplate(template, salon)
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: salon.email || '',
    su: rendered.subject,
    body: customBody || rendered.body,
  })
  return `https://mail.google.com/mail/?${params.toString()}`
}

// -----------------------------------------------------
// LINE 用テキスト（コピペ用）
// -----------------------------------------------------
export function buildLineText(salon, template, customBody) {
  const rendered = renderTemplate(template, salon)
  return customBody || rendered.body
}

// -----------------------------------------------------
// 複数サロンを CSV で一括エクスポート
// メルマガ配信ツールや LINE 公式アカウントの一斉送信に流し込める
// -----------------------------------------------------
export function buildBulkCsv(salons, template) {
  const header = template.type === 'mail'
    ? ['サロン名', 'メール', '件名', '本文']
    : ['サロン名', '本文']

  const rows = salons.map((s) => {
    const r = renderTemplate(template, s)
    if (template.type === 'mail') {
      return [s.name, s.email || '', r.subject, r.body]
    }
    return [s.name, r.body]
  })

  const esc = (v) => {
    const str = String(v ?? '')
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }

  const lines = [header, ...rows].map((row) => row.map(esc).join(','))
  // Excel で開く場合に文字化け防止：BOM 付与
  return '\uFEFF' + lines.join('\r\n')
}

export function downloadCsv(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * template.id から template オブジェクトを検索
 */
export function findTemplate(id) {
  return OUTREACH_TEMPLATES.find((t) => t.id === id)
}

/**
 * risk 層に応じたおすすめテンプレート
 */
export function recommendedTemplates(risk) {
  return OUTREACH_TEMPLATES.filter((t) =>
    !t.recommendedFor || t.recommendedFor.includes(risk),
  )
}
