import { Link } from 'react-router-dom'

const stats = [
  { value: '500+', label: '導入サロン数' },
  { value: '98%', label: '商品満足度' },
  { value: '92%', label: 'リピート率' },
]

const products = [
  {
    name: 'ボンバークリーム',
    tag: '主力商品',
    desc: '独自処方のエイジングケアクリーム。サロンの施術効果を最大限に引き出し、お客様の肌に確かな結果をお届けします。',
    gradient: 'from-indigo-600 to-purple-700',
  },
  {
    name: 'ハーブぷるクリーム',
    tag: '業務用200g',
    desc: '天然ハーブ配合の高保湿クリーム。施術中の肌をやさしく守りながら、うるおいを深層まで届けます。',
    gradient: 'from-emerald-600 to-teal-700',
  },
  {
    name: 'ハーブローション',
    tag: '業務用500ml',
    desc: '植物由来成分で肌を整えるサロン専用ローション。施術前後の肌コンディションを最適化します。',
    gradient: 'from-amber-500 to-orange-600',
  },
]

export default function HomePage() {
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
            <Link
              to="/products"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-white text-slate-900 font-semibold text-sm hover:bg-amber-50 transition-colors shadow-lg"
            >
              商品を見る
            </Link>
            <Link
              to="/salon-search"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full border border-white/40 text-white font-semibold text-sm hover:bg-white/10 transition-colors"
            >
              取扱サロンを探す
            </Link>
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
            {products.map((p) => (
              <div
                key={p.name}
                className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow"
              >
                {/* カード上部：グラデーション */}
                <div
                  className={`h-48 bg-gradient-to-br ${p.gradient} flex items-center justify-center`}
                >
                  <span className="text-white/90 text-5xl select-none">
                    {/* 装飾アイコン */}
                    <svg
                      viewBox="0 0 48 48"
                      fill="none"
                      className="w-16 h-16 opacity-60"
                    >
                      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
                      <path
                        d="M24 12v24M12 24h24"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                </div>
                <div className="p-6">
                  <span className="inline-block text-[10px] font-bold tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 mb-3">
                    {p.tag}
                  </span>
                  <h3 className="text-lg font-bold text-slate-900 mb-2">
                    {p.name}
                  </h3>
                  <p className="text-sm text-slate-500 leading-relaxed">
                    {p.desc}
                  </p>
                </div>
              </div>
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

      {/* ── CTA: パートナー ── */}
      <section className="py-20 sm:py-28 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-amber-600 text-xs tracking-[0.25em] font-semibold mb-4">
            FOR PROFESSIONALS
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-6">
            サロン様・代理店様へ
          </h2>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed mb-8">
            VAVITTEは共に成長できるパートナーを募集しています。
            <br className="hidden sm:block" />
            サロン導入・代理店契約についてお気軽にお問い合わせください。
          </p>
          <Link
            to="/partner"
            className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
          >
            パートナー募集の詳細へ
          </Link>
        </div>
      </section>
    </>
  )
}
