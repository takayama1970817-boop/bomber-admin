import { Link } from 'react-router-dom'
import { usePublicProducts } from '../../hooks/usePublicProducts.js'

const stats = [
  { value: '500+', label: '導入サロン数' },
  { value: '98%', label: '商品満足度' },
  { value: '92%', label: 'リピート率' },
]

const markets = [
  {
    code: 'JP',
    flag: '🇯🇵',
    country: 'Japan',
    countryJa: '日本',
    brand: 'VAVITTE',
    status: '展開中',
    statusTone: 'active',
    accent: 'from-rose-50 to-red-50',
    accentBorder: 'border-rose-200',
    scale: '全国500店舗以上',
    desc: '本国市場として、全国のサロン専売ネットワークを通じて、プロフェッショナル品質のスキンケアをお届けしています。',
  },
  {
    code: 'CN',
    flag: '🇨🇳',
    country: 'China',
    countryJa: '中国',
    brand: 'VEBOL',
    status: '展開中',
    statusTone: 'active',
    accent: 'from-amber-50 to-yellow-50',
    accentBorder: 'border-amber-200',
    scale: '現地パートナー連携',
    desc: '中国市場向けブランド「VEBOL」として、日本品質のサロン専売スキンケアを展開。現地パートナーと共に成長しています。',
  },
  {
    code: 'ID',
    flag: '🇮🇩',
    country: 'Indonesia',
    countryJa: 'インドネシア',
    brand: 'VAVITTE',
    status: '1 Salon',
    statusTone: 'boutique',
    accent: 'from-emerald-50 to-teal-50',
    accentBorder: 'border-emerald-200',
    scale: '厳選1店舗で展開中',
    desc: '東南アジア展開の第一歩として、現地のプロフェッショナルサロンで VAVITTE を厳選取扱。信頼あるパートナーと共に、慎重に市場を広げています。',
  },
]

export default function HomePage() {
  const { products } = usePublicProducts()
  const featuredProducts = products.slice(0, 3)

  return (
    <>
      {/* ── ヒーロー ── */}
      <section className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white">
        {/* 装飾 */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-indigo-500 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-amber-400 blur-3xl" />
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-28 sm:py-36 lg:py-44 text-center">
          <p className="text-amber-400 text-xs sm:text-sm tracking-[0.3em] font-semibold mb-6">
            VAVITTE BY ROYAL TRUST
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
            あなたの肌に、
            <br className="sm:hidden" />
            本物の結果を。
          </h1>
          <p className="max-w-2xl mx-auto text-slate-300 text-sm sm:text-base leading-relaxed mb-10">
            VAVITTE（バビッテ）は、プロフェッショナルが認めたサロン専売化粧品ブランド。
            <br className="hidden sm:block" />
            確かな成分と独自処方で、あなたの肌が求める「結果」をお届けします。
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            {/* 主 CTA: サロン検索（Coming Soon） */}
            <Link
              to="/salon-search"
              className="inline-flex items-center gap-2 px-8 py-3 rounded-full bg-white text-slate-900 font-semibold text-sm hover:bg-amber-50 transition-colors shadow-lg"
            >
              取扱サロンを探す
              <span className="text-[10px] font-bold tracking-wider text-amber-700 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">
                Coming Soon
              </span>
            </Link>
            {/* 従 CTA: 商品一覧 */}
            <Link
              to="/products"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full border border-white/40 text-white font-semibold text-sm hover:bg-white/10 transition-colors"
            >
              商品を見る
            </Link>
          </div>
        </div>
      </section>

      {/* ── 信頼ブロック（ヒーロー直下） ── */}
      <section className="bg-white border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8">
            {/* サロン専売 */}
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-indigo-50 text-indigo-700 flex-shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-bold text-slate-900">サロン専売品</p>
                <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                  プロの現場で選ばれる流通限定品
                </p>
              </div>
            </div>

            {/* 日本製 */}
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-rose-50 text-rose-700 flex-shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-bold text-slate-900">日本国内で企画・製造</p>
                <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                  厳格な品質基準で一つひとつ
                </p>
              </div>
            </div>

            {/* プロが推奨 */}
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-50 text-amber-700 flex-shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-bold text-slate-900">プロの現場から逆算</p>
                <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                  サロン現場の声を反映した処方
                </p>
              </div>
            </div>

            {/* 導入実績 */}
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-50 text-emerald-700 flex-shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.281m5.94 2.28l-2.28 5.941" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-bold text-slate-900">全国500店舗以上が導入</p>
                <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                  継続支持されるサロンパートナー
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── ブランドストーリー ── */}
      <section className="py-20 sm:py-28 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-4">
            OUR PHILOSOPHY
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-8">
            「結果」で選ばれるブランドへ
          </h2>
          <p className="text-slate-600 leading-relaxed text-sm sm:text-base">
            VAVITTEは「本当に肌が変わる」ことだけを追求して生まれました。
            市場には数えきれないほどの化粧品がありますが、私たちが目指すのはただひとつ
            ――プロのサロンが自信を持ってお客様にお届けできる「確かな結果」です。
          </p>
          <p className="text-slate-600 leading-relaxed text-sm sm:text-base mt-4">
            厳選された原料、独自の処方技術、そしてサロン専売という流通へのこだわり。
            すべては、お客様の肌と向き合うプロフェッショナルの信頼に応えるためです。
          </p>
        </div>
      </section>

      {/* ── 注目商品 ── */}
      <section className="py-20 sm:py-28 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-4">
              FEATURED PRODUCTS
            </p>
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">
              プロが選ぶVAVITTE製品
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {featuredProducts.map((p) => (
              <Link
                key={p.slug}
                to={`/products/${p.slug}`}
                className="group bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all"
              >
                {/* カード上部：グラデーション */}
                <div
                  className={`h-48 bg-gradient-to-br ${p.gradient} flex items-center justify-center`}
                >
                  <svg
                    viewBox="0 0 48 48"
                    fill="none"
                    className="w-16 h-16 text-white/60 transition-transform group-hover:scale-110"
                  >
                    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
                    <path
                      d="M24 12v24M12 24h24"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="p-6">
                  {p.badge && (
                    <span className="inline-block text-[10px] font-bold tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 mb-3">
                      {p.badge}
                    </span>
                  )}
                  <h3 className="text-lg font-bold text-slate-900 mb-2 group-hover:text-indigo-700 transition-colors">
                    {p.name}
                  </h3>
                  <p className="text-sm text-slate-500 leading-relaxed">
                    {p.shortDesc}
                  </p>
                </div>
              </Link>
            ))}
          </div>

          <div className="text-center mt-10">
            <Link
              to="/products"
              className="inline-flex items-center gap-2 text-sm font-semibold text-indigo-700 hover:text-indigo-900 transition-colors"
            >
              すべての商品を見る
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── 数字 ── */}
      <section className="py-20 bg-gradient-to-br from-indigo-900 to-slate-900 text-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 text-center">
            {stats.map((s) => (
              <div key={s.label}>
                <p className="text-4xl sm:text-5xl font-bold text-amber-400 mb-2">
                  {s.value}
                </p>
                <p className="text-sm text-slate-300 tracking-wide">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 海外展開 ── */}
      <section className="relative overflow-hidden py-20 sm:py-28 bg-gradient-to-b from-white via-slate-50 to-white">
        {/* 背景装飾: 地球儀風の同心円 */}
        <div className="absolute inset-0 pointer-events-none select-none opacity-[0.04]">
          <svg
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[780px] h-[780px]"
            viewBox="0 0 200 200"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.4"
          >
            <circle cx="100" cy="100" r="90" />
            <circle cx="100" cy="100" r="70" />
            <circle cx="100" cy="100" r="50" />
            <circle cx="100" cy="100" r="30" />
            <line x1="10" y1="100" x2="190" y2="100" />
            <line x1="100" y1="10" x2="100" y2="190" />
            <ellipse cx="100" cy="100" rx="90" ry="45" />
            <ellipse cx="100" cy="100" rx="90" ry="30" />
            <ellipse cx="100" cy="100" rx="45" ry="90" />
          </svg>
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14 sm:mb-16">
            <p className="text-amber-600 text-xs tracking-[0.3em] font-semibold mb-4">
              GLOBAL EXPANSION
            </p>
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 mb-6">
              世界へ広がる、VAVITTE の品質
            </h2>
            <p className="text-slate-600 text-sm sm:text-base leading-relaxed max-w-3xl mx-auto">
              日本で磨き上げたプロフェッショナル処方を、アジアのサロン市場へ。
              <br className="hidden sm:block" />
              国ごとにブランド・流通・プロトコルを最適化し、各地の美容文化に寄り添う形で展開しています。
              <br className="hidden sm:block" />
              急成長より、確かな信頼の積み重ねを優先する——それが私たちのグローバル方針です。
            </p>

            {/* 国旗ストリップ */}
            <div className="mt-10 flex items-center justify-center gap-6 sm:gap-12">
              {markets.map((m, i) => (
                <div key={m.code} className="flex items-center gap-4">
                  <div className="flex flex-col items-center">
                    <span className="text-4xl sm:text-5xl leading-none select-none mb-2" aria-hidden="true">
                      {m.flag}
                    </span>
                    <p className="text-[10px] tracking-[0.2em] text-slate-400 font-bold">
                      {m.country.toUpperCase()}
                    </p>
                  </div>
                  {i < markets.length - 1 && (
                    <span className="text-slate-300 text-xl select-none" aria-hidden="true">—</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
            {markets.map((m) => (
              <div
                key={m.code}
                className={`relative bg-white rounded-2xl p-8 border ${m.accentBorder} shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all`}
              >
                {/* 上部バンド: 国のアクセント色 */}
                <div
                  className={`absolute top-0 inset-x-0 h-1.5 rounded-t-2xl bg-gradient-to-r ${m.accent}`}
                  aria-hidden="true"
                />

                <div className="flex items-center justify-between mb-6">
                  <span className="text-5xl leading-none select-none" aria-hidden="true">
                    {m.flag}
                  </span>
                  <span
                    className={`text-[10px] font-bold tracking-wider px-3 py-1.5 rounded-full ${
                      m.statusTone === 'active'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : m.statusTone === 'boutique'
                        ? 'bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 border border-amber-300'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}
                  >
                    {m.status}
                  </span>
                </div>

                <p className="text-[11px] tracking-[0.25em] text-slate-400 font-semibold mb-1">
                  {m.country.toUpperCase()}
                </p>
                <p className="text-2xl font-bold text-slate-900 mb-1">
                  {m.countryJa}
                </p>

                {/* ブランド名を大きく */}
                <div className="mt-4 mb-5 pb-5 border-b border-slate-100">
                  <p className="text-[10px] tracking-[0.25em] text-slate-400 font-bold mb-1">
                    BRAND
                  </p>
                  <p className="text-lg font-bold tracking-wide text-indigo-700">
                    {m.brand}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">{m.scale}</p>
                </div>

                <p className="text-sm text-slate-600 leading-relaxed">
                  {m.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
