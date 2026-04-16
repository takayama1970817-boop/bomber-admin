import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import ReceiptPrintable from '../components/ReceiptPrintable.jsx'
import { generateReceiptPdf } from '../lib/generateReceiptPdf.js'

/**
 * 公開領収書ページ（認証不要）
 *
 * URL例: /receipt?order=17756363328&mail=salon@example.com
 *
 * Bカートのメールひな形にこのURLを固定で貼っておけば、
 * お客様がクリックするだけで領収書をダウンロードできる。
 */
export default function PublicReceipt() {
  const [params] = useSearchParams()
  const orderNumber = params.get('order') || ''
  const mail = (params.get('mail') || '').trim().toLowerCase()

  const [status, setStatus] = useState('loading') // loading | found | notfound | expired | error
  const [receiptData, setReceiptData] = useState(null)
  const [generating, setGenerating] = useState(false)
  const receiptRef = useRef(null)

  useEffect(() => {
    if (!orderNumber || !mail) {
      setStatus('notfound')
      return
    }

    let cancelled = false

    const lookup = async () => {
      try {
        const q = query(
          collection(db, 'publicReceipts'),
          where('orderNumber', '==', orderNumber),
        )
        const snap = await getDocs(q)

        if (cancelled) return

        if (snap.empty) {
          setStatus('notfound')
          return
        }

        const doc = snap.docs[0]
        const data = doc.data()

        // メールアドレス照合（小文字比較）
        if ((data.email || '').trim().toLowerCase() !== mail) {
          setStatus('notfound')
          return
        }

        // 有効期限チェック
        if (data.expiresAt) {
          const expires = data.expiresAt.toDate
            ? data.expiresAt.toDate()
            : new Date(data.expiresAt)
          if (expires < new Date()) {
            setStatus('expired')
            return
          }
        }

        // parsed 形式に変換（ReceiptPrintable が受け取れる形）
        const orderDate = data.orderDate?.toDate
          ? data.orderDate.toDate()
          : data.orderDate
            ? new Date(data.orderDate)
            : new Date()

        setReceiptData({
          customer: {
            companyName: data.companyName || '',
            contact: data.contact || '',
          },
          order: {
            orderNumber: data.orderNumber,
            orderDate,
            paymentMethod: data.paymentMethod || '',
            subtotal: data.subtotal || 0,
            shipping: data.shipping || 0,
            total: data.total || 0,
            tax: data.tax || 0,
          },
          items: [],
        })
        setStatus('found')
      } catch (e) {
        console.error('PublicReceipt lookup failed:', e)
        if (!cancelled) setStatus('error')
      }
    }

    lookup()
    return () => {
      cancelled = true
    }
  }, [orderNumber, mail])

  const handleDownload = async () => {
    if (!receiptRef.current || !receiptData) return
    setGenerating(true)
    try {
      await generateReceiptPdf(receiptRef.current, receiptData)
    } catch (e) {
      console.error(e)
      alert('PDFの生成に失敗しました。お手数ですがもう一度お試しください。')
    } finally {
      setGenerating(false)
    }
  }

  // --- レイアウト ---
  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f5f5f5',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '40px 20px',
        fontFamily:
          '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
      }}
    >
      {/* ヘッダー */}
      <div style={{ marginBottom: '24px', textAlign: 'center' }}>
        <div
          style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}
        >
          ロイヤルトラスト株式会社
        </div>
        <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>
          電子領収書ダウンロード
        </div>
      </div>

      {/* ステータス分岐 */}
      {status === 'loading' && (
        <div style={cardStyle}>
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#888' }}>
            領収書を検索しています...
          </div>
        </div>
      )}

      {status === 'notfound' && (
        <div style={cardStyle}>
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📄</div>
            <div
              style={{ fontSize: '16px', fontWeight: 'bold', color: '#333', marginBottom: '12px' }}
            >
              領収書が見つかりませんでした
            </div>
            <div style={{ fontSize: '13px', color: '#888', lineHeight: '1.8' }}>
              注文番号またはメールアドレスが正しくない可能性があります。
              <br />
              ご注文確認メールに記載の情報をご確認ください。
              <br />
              <br />
              ご不明な点がございましたら、弊社までお問い合わせください。
            </div>
          </div>
        </div>
      )}

      {status === 'expired' && (
        <div style={cardStyle}>
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>⏰</div>
            <div
              style={{ fontSize: '16px', fontWeight: 'bold', color: '#333', marginBottom: '12px' }}
            >
              領収書の有効期限が切れています
            </div>
            <div style={{ fontSize: '13px', color: '#888', lineHeight: '1.8' }}>
              領収書のダウンロード期限（60日間）を過ぎました。
              <br />
              再発行が必要な場合は、弊社までメールにてご連絡ください。
            </div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div style={cardStyle}>
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
            <div
              style={{ fontSize: '16px', fontWeight: 'bold', color: '#333', marginBottom: '12px' }}
            >
              エラーが発生しました
            </div>
            <div style={{ fontSize: '13px', color: '#888', lineHeight: '1.8' }}>
              通信エラーが発生しました。
              <br />
              しばらく時間をおいて再度お試しください。
            </div>
          </div>
        </div>
      )}

      {status === 'found' && receiptData && (
        <>
          {/* ダウンロードボタン */}
          <div style={{ ...cardStyle, textAlign: 'center', padding: '30px' }}>
            <div
              style={{ fontSize: '15px', fontWeight: 'bold', color: '#333', marginBottom: '6px' }}
            >
              {receiptData.customer.companyName} 様
            </div>
            <div style={{ fontSize: '13px', color: '#888', marginBottom: '4px' }}>
              注文番号：{receiptData.order.orderNumber}
            </div>
            <div
              style={{ fontSize: '24px', fontWeight: 'bold', color: '#111', marginBottom: '20px' }}
            >
              ¥{receiptData.order.total.toLocaleString('ja-JP')}
              <span style={{ fontSize: '13px', fontWeight: 'normal', color: '#888', marginLeft: '8px' }}>
                （税込）
              </span>
            </div>

            <button
              onClick={handleDownload}
              disabled={generating}
              style={{
                display: 'inline-block',
                padding: '14px 40px',
                fontSize: '15px',
                fontWeight: 'bold',
                color: '#fff',
                backgroundColor: generating ? '#999' : '#2563eb',
                border: 'none',
                borderRadius: '8px',
                cursor: generating ? 'default' : 'pointer',
                transition: 'background-color 0.2s',
              }}
              onMouseOver={(e) => {
                if (!generating) e.currentTarget.style.backgroundColor = '#1d4ed8'
              }}
              onMouseOut={(e) => {
                if (!generating) e.currentTarget.style.backgroundColor = '#2563eb'
              }}
            >
              {generating ? 'PDF 生成中...' : '📄 領収書PDFをダウンロード'}
            </button>

            <div style={{ marginTop: '16px', fontSize: '11px', color: '#aaa', lineHeight: '1.8' }}>
              ※ インボイス制度対応の適格請求書（電子領収書）です
              <br />
              ※ 有効期限内であれば何度でもダウンロードいただけます
            </div>
          </div>

          {/* PDF生成用の非表示テンプレート */}
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: '-10000px',
              pointerEvents: 'none',
              opacity: 0,
            }}
            aria-hidden
          >
            <ReceiptPrintable ref={receiptRef} parsed={receiptData} />
          </div>
        </>
      )}

      {/* フッター */}
      <div
        style={{
          marginTop: '40px',
          fontSize: '11px',
          color: '#aaa',
          textAlign: 'center',
          lineHeight: '1.8',
        }}
      >
        <div>ロイヤルトラスト株式会社</div>
        <div>〒150-0012 東京都渋谷区広尾5-24-3</div>
        <div>TEL: 03-3441-7839</div>
      </div>
    </div>
  )
}

const cardStyle = {
  width: '100%',
  maxWidth: '520px',
  backgroundColor: '#fff',
  borderRadius: '12px',
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  overflow: 'hidden',
  marginBottom: '16px',
}
