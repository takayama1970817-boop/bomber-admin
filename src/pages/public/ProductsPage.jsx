import { Link } from 'react-router-dom'

const products = [
  {
    name: 'ボンバークリーム',
    category: 'エイジングケア',
    badge: '主力商品',
    desc: 'VAVITTE の看板製品。独自処方のエイジングケアクリームが、年齢を重ねた肌にハリと弾力を呼び覚まします。サロン施術との相乗効果で、お客様の満足度を大幅に向上させます。',
    gradient: 'from-indigo-600 to-purple-700',
  },
  {
    name: 'ハーブぷるクリーム',
    category: '高保湿・業務用',
    badge: '業務用 200g',
    desc: '厳選された天然ハーブを贅沢に配合した高保湿クリーム。ぷるぷるのテクスチャーが肌に密着し、施術中の乾燥を防ぎながら深層までうるおいを届けます。',
    gradient: 'from-emerald-600 to-teal-700',
  },
  {
    name: 'ハーブローション',
    category: '化粧水・業務用',
    badge: '業務用 500ml',
    desc: '植物由来の美容成分がたっぷりのサロン専用ローション。施術前後の肌コンディションを整え、後に続くクリームの浸透力を高めます。',
    gradient: 'from-amber-500 to-orange-600',
  },
  {
    name: 'クレンジングミルク',
    category: 'クレンジング',
    badge: null,
    desc: 'ミルクタイプのやさしい洗い心地で、メイクや汚れをしっかり落としながら必要なうるおいは残します。デリケートな肌にも安心して使えるサロン品質。',
    gradient: 'from-rose-500 to-pink-700',
  },
  {
    name: 'ビタミンEコンセントレートエッセンス',
    category: '美容液',
    badge: null,
    desc: '高濃度ビタミンE配合の集中美容液。肌の酸化ダメージをケアし、くすみのない透明感あふれる肌へ導きます。施術メニューの付加価値アップに最適です。',
    gradient: 'from-yellow-500 to-amber-700',
  },
]

export default function ProductsPage() {
  return (
    <>
      {/* ヘッダー */}
      <section className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white py-20 sm:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-amber-400 text-xs tracking-[0.3em] font-semibold mb-4">
            VAVITTE PRODUCTS
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            商品紹介
          </h1>
          <p className="mt-4 text-slate-300 text-sm sm:text-base max-w-xl mx-auto">
            プロフェッショナルが認めた、サロン専売の高機能スキンケア製品
          </p>
        </div>
      </section>

      {/* 商品グリッド */}
      <section className="py-16 sm:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {products.map((p) => (
              <div
                key={p.name}
                className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-shadow flex flex-col"
              >
                {/* ビジュアル */}
                <div
                  className={`h-52 bg-gradient-to-br ${p.gradient} flex items-center justify-center relative`}
                >
                  <svg
                    viewBox="0 0 48 48"
                    fill="none"
                    className="w-14 h-14 text-white/50"
                  >
                    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
                    <path
                      d="M24 12v24M12 24h24"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  {/* サロン専売バッジ */}
                  <span className="absolute top-3 right-3 bg-white/20 backdrop-blur text-white text-[10px] font-bold tracking-wider px-2.5 py-1 rounded-full">
                    サロン専売品
                  </span>
                </div>

                {/* 情報 */}
                <div className="p-6 flex flex-col flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] tracking-wider text-indigo-600 font-semibold">
                      {p.category}
                    </span>
                    {p.badge && (
                      <span className="text-[10px] font-bold tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                        {p.badge}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-3">
                    {p.name}
                  </h3>
                  <p className="text-sm text-slate-500 leading-relaxed flex-1">
                    {p.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-4">
            VAVITTE製品を体験しませんか？
          </h2>
          <p className="text-slate-600 text-sm sm:text-base mb-8">
            VAVITTE製品はサロン専売品です。お近くの取扱サロンでお試しいただけます。
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/salon-search"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
            >
              取扱サロンを探す
            </Link>
            <Link
              to="/partner"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full border border-slate-300 text-slate-700 font-semibold text-sm hover:border-indigo-300 hover:text-indigo-700 transition-colors"
            >
              サロン導入について
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
