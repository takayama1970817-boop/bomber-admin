import { forwardRef } from 'react'

// 発行元情報（receiptEmail.js と揃える）
const ISSUER = {
  name: 'ロイヤルトラスト株式会社',
  zip: '150-0012',
  address: '東京都渋谷区広尾5-24-3',
  tel: '03-3441-7839',
  url: 'http://royaltrust.jp/',
  invoiceNo: 'T5120001125556', // 適格請求書発行事業者 登録番号
  sealImage: '/inkan.png', // public/inkan.png を参照
}

const yen = (n) => '¥' + (n ?? 0).toLocaleString('ja-JP')

const fmtDate = (d) => {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`
}

// A4 縦: 210mm x 297mm → 794px x 1123px (96dpi)
// html2canvas で読み取れるように画面外に配置する親要素の中で使う
const ReceiptPrintable = forwardRef(function ReceiptPrintable({ parsed }, ref) {
  if (!parsed) return null

  const { customer, order } = parsed
  const issueDate = fmtDate(new Date())
  const orderDate = fmtDate(order.orderDate)

  return (
    <div
      ref={ref}
      style={{
        width: '794px',
        height: '1123px',
        overflow: 'hidden',
        padding: '44px 70px',
        backgroundColor: '#ffffff',
        color: '#111111',
        fontFamily:
          '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
        fontSize: '14px',
        lineHeight: '1.6',
        boxSizing: 'border-box',
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          textAlign: 'center',
          borderBottom: '3px double #111',
          paddingBottom: '14px',
          marginBottom: '20px',
        }}
      >
        <div
          style={{
            fontSize: '36px',
            fontWeight: 'bold',
            letterSpacing: '20px',
            paddingLeft: '20px',
          }}
        >
          領収書
        </div>
      </div>

      {/* 宛名と発行日 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: '20px',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '20px',
              fontWeight: 'bold',
              borderBottom: '1px solid #111',
              paddingBottom: '6px',
              minWidth: '360px',
            }}
          >
            {customer.companyName} 様
          </div>
          {customer.contact && (
            <div style={{ marginTop: '6px', fontSize: '13px', color: '#444' }}>
              ご担当：{customer.contact} 様
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', fontSize: '13px' }}>
          <div>発行日：{issueDate}</div>
          <div>No. {order.orderNumber}</div>
        </div>
      </div>

      {/* 金額（大きく） */}
      <div
        style={{
          border: '2px solid #111',
          padding: '16px 30px',
          marginBottom: '18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontSize: '16px', fontWeight: 'bold' }}>金額</div>
        <div style={{ fontSize: '32px', fontWeight: 'bold' }}>
          {yen(order.total)}-
        </div>
        <div style={{ fontSize: '13px', color: '#555' }}>
          （税込・うち消費税 {yen(order.tax)}）
        </div>
      </div>

      {/* 但し書き */}
      <div
        style={{
          marginBottom: '18px',
          fontSize: '14px',
          borderBottom: '1px solid #999',
          paddingBottom: '8px',
        }}
      >
        <span style={{ color: '#555' }}>但し、</span>
        <span style={{ fontWeight: 'bold', marginLeft: '8px' }}>
          商品代金として
        </span>
        <span style={{ marginLeft: '20px', color: '#555' }}>
          上記正に領収いたしました。
        </span>
      </div>

      {/* ご注文情報 */}
      <div style={{ fontSize: '12px', color: '#444', marginBottom: '14px' }}>
        <div>ご注文日：{orderDate}</div>
        {order.paymentMethod && <div>決済方法：{order.paymentMethod}</div>}
      </div>

      {/* 内訳（インボイス制度対応） */}
      <div
        style={{
          marginBottom: '16px',
          padding: '12px 20px',
          border: '1px solid #999',
          borderRadius: '4px',
          fontSize: '13px',
          lineHeight: '1.8',
        }}
      >
        <div
          style={{
            fontSize: '12px',
            fontWeight: 'bold',
            marginBottom: '6px',
            color: '#555',
          }}
        >
          【 内訳 】
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>商品合計（税抜）</span>
          <span>{yen(order.subtotal)}</span>
        </div>
        {order.shipping > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>送料</span>
            <span>{yen(order.shipping)}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>10%対象 消費税</span>
          <span>{yen(order.tax)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px solid #ccc',
            fontWeight: 'bold',
          }}
        >
          <span>合計（税込）</span>
          <span>{yen(order.total)}</span>
        </div>
      </div>

      {/* 発行元（右寄せ・内訳のすぐ下） */}
      <div
        style={{
          marginTop: '4px',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            flexShrink: 0,
            marginRight: '59px',
          }}
        >
          <div
            style={{
              textAlign: 'left',
              fontSize: '13px',
              lineHeight: '1.8',
              borderLeft: '3px solid #111',
              paddingLeft: '16px',
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ fontSize: '15px', fontWeight: 'bold' }}>
              {ISSUER.name}
            </div>
            <div>〒{ISSUER.zip}</div>
            <div>{ISSUER.address}</div>
            <div>TEL：{ISSUER.tel}</div>
            <div>{ISSUER.url}</div>
          </div>

          {/* 社印（テキストの右横に配置） */}
          <img
            src={ISSUER.sealImage}
            alt=""
            crossOrigin="anonymous"
            style={{
              width: '85px',
              height: '85px',
              objectFit: 'contain',
              opacity: 0.92,
              flexShrink: 0,
            }}
            onError={(e) => {
              // 画像が無い場合は非表示（エラーで PDF 生成が止まらないように）
              e.currentTarget.style.display = 'none'
            }}
          />
        </div>
      </div>

      {/* 注意書き（全幅・改行なしで1行ずつ） */}
      <div
        style={{
          marginTop: '18px',
          fontSize: '11px',
          color: '#555',
          lineHeight: '1.8',
          whiteSpace: 'nowrap',
        }}
      >
        <div>※ 本書は電子領収書として発行しております。</div>
        <div>
          ※ 電子取引のため収入印紙の貼付は不要です（印紙税法基本通達第44条）。
        </div>
        <div>
          ※ 適格請求書発行事業者 登録番号：{ISSUER.invoiceNo}
        </div>
      </div>
    </div>
  )
})

export default ReceiptPrintable
