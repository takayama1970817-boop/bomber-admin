import { useState, useEffect } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../../lib/firebase'
import { Link } from 'react-router-dom'

const PREFECTURES = [
  '北海道',
  '青森県','岩手県','宮城県','秋田県','山形県','福島県',
  '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
  '新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県',
  '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県',
  '徳島県','香川県','愛媛県','高知県',
  '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
]

export default function SalonSearchPage() {
  const [salons, setSalons] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [prefFilter, setPrefFilter] = useState('')

  useEffect(() => {
    async function fetchSalons() {
      try {
        // dealerSalons から own 以外を取得
        const salonsRef = collection(db, 'dealerSalons')
        const q = query(salonsRef, where('type', '!=', 'own'))
        const snap = await getDocs(q)
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

        // allowedEmails からサロンロールも取得して補完
        try {
          const emailsRef = collection(db, 'allowedEmails')
          const eq = query(emailsRef, where('role', '==', 'salon'))
          const emailSnap = await getDocs(eq)
          const emailSalons = emailSnap.docs.map((d) => ({
            id: d.id,
            ...d.data(),
          }))

          // 重複しないサロン名を追加
          const existingNames = new Set(list.map((s) => s.salonName || s.name))
          emailSalons.forEach((es) => {
            const name = es.salonName || es.name
            if (name && !existingNames.has(name)) {
              list.push({
                id: es.id,
                name: name,
                area: es.area || es.prefecture || '',
                address: es.address || '',
              })
              existingNames.add(name)
            }
          })
        } catch {
          // allowedEmails の読み取りに失敗しても続行
        }

        setSalons(list)
      } catch (err) {
        console.error('サロン情報の取得に失敗:', err)
        setError('サロン情報を準備中です。しばらくお待ちください。')
      } finally {
        setLoading(false)
      }
    }

    fetchSalons()
  }, [])

  const displaySalons = prefFilter
    ? salons.filter((s) => {
        const area = s.area || s.prefecture || s.address || ''
        return area.includes(prefFilter)
      })
    : salons

  return (
    <>
      {/* ヘッダー */}
      <section className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white py-20 sm:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-amber-400 text-xs tracking-[0.3em] font-semibold mb-4">
            SALON SEARCH
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            取扱サロン検索
          </h1>
          <p className="mt-4 text-slate-300 text-sm sm:text-base max-w-xl mx-auto">
            VAVITTE製品をお取扱いいただいているサロンをお探しいただけます
          </p>
        </div>
      </section>

      {/* 検索・一覧 */}
      <section className="py-16 sm:py-24 bg-slate-50 min-h-[50vh]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* フィルター */}
          <div className="mb-10 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <label className="text-sm font-semibold text-slate-700">
              都道府県で絞り込み
            </label>
            <select
              value={prefFilter}
              onChange={(e) => setPrefFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
            >
              <option value="">すべて表示</option>
              {PREFECTURES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* 読み込み中 */}
          {loading && (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
              <p className="mt-4 text-sm text-slate-500">サロン情報を読み込んでいます...</p>
            </div>
          )}

          {/* エラー */}
          {error && !loading && (
            <div className="text-center py-20">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-50 mb-4">
                <svg className="w-8 h-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <p className="text-slate-600 text-sm">{error}</p>
              <p className="text-slate-400 text-xs mt-2">
                お急ぎの場合は
                <Link to="/partner" className="text-indigo-600 hover:underline ml-1">
                  お問い合わせ
                </Link>
                よりご連絡ください。
              </p>
            </div>
          )}

          {/* サロン一覧 */}
          {!loading && !error && (
            <>
              {displaySalons.length === 0 ? (
                <div className="text-center py-20">
                  <p className="text-slate-500 text-sm">
                    {prefFilter
                      ? `${prefFilter}に該当するサロンが見つかりませんでした`
                      : '現在サロン情報を準備中です'}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-400 mb-4">
                    {displaySalons.length} 件のサロンが見つかりました
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {displaySalons.map((s) => (
                      <div
                        key={s.id}
                        className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow border border-slate-100"
                      >
                        <h3 className="text-base font-bold text-slate-900 mb-1">
                          {s.salonName || s.name || '（サロン名未設定）'}
                        </h3>
                        {(s.area || s.prefecture || s.address) && (
                          <p className="text-xs text-slate-500">
                            {s.area || s.prefecture}
                            {s.address ? ` ${s.address}` : ''}
                          </p>
                        )}
                        <span className="inline-block mt-3 text-[10px] font-bold tracking-wider text-indigo-600 bg-indigo-50 rounded px-2 py-0.5">
                          VAVITTE取扱店
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mb-4">
            サロンでVAVITTEの導入をご検討中の方へ
          </h2>
          <p className="text-slate-600 text-sm mb-6">
            導入に関するご相談や資料請求を承っています。
          </p>
          <Link
            to="/partner"
            className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
          >
            サロン導入のご相談
          </Link>
        </div>
      </section>
    </>
  )
}
