import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { products, CATEGORIES } from '../../data/products.js'

export default function ProductsPage() {
  const [activeCategory, setActiveCategory] = useState('all')
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return products.filter((p) => {
      if (activeCategory !== 'all' && p.categoryKey !== activeCategory) return false
      if (!kw) return true
      return (
        p.name.toLowerCase().includes(kw) ||
        p.shortDesc.toLowerCase().includes(kw) ||
        (p.code && p.code.toLowerCase().includes(kw))
      )
    })
  }, [activeCategory, keyword])

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

      {/* 検索・カテゴリ */}
      <section className="bg-white border-b border-slate-100 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:gap-6">
            {/* カテゴリ */}
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setActiveCategory(c.key)}
                  className={`px-4 py-2 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                    activeCategory === c.key
                      ? 'bg-indigo-700 text-white border-indigo-700'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-700'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* 検索 */}
            <div className="lg:ml-auto lg:w-72">
              <div className="relative">
                <input
                  type="search"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="商品名・品番で検索"
                  className="w-full rounded-full border border-slate-200 bg-slate-50 pl-10 pr-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 focus:bg-white outline-none"
                />
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 商品グリッド */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {filtered.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-slate-500 text-sm">
                該当する商品が見つかりませんでした
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-400 mb-6">
                {filtered.length} 件の商品
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
                {filtered.map((p) => (
                  <Link
                    key={p.slug}
                    to={`/products/${p.slug}`}
                    className="group bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all flex flex-col"
                  >
                    {/* ビジュアル */}
                    <div
                      className={`h-52 bg-gradient-to-br ${p.gradient} flex items-center justify-center relative`}
                    >
                      <svg
                        viewBox="0 0 48 48"
                        fill="none"
                        className="w-14 h-14 text-white/50 transition-transform group-hover:scale-110"
                      >
                        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" />
                        <path
                          d="M24 12v24M12 24h24"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
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
                      <h3 className="text-lg font-bold text-slate-900 mb-2 group-hover:text-indigo-700 transition-colors">
                        {p.name}
                      </h3>
                      <p className="text-sm text-slate-500 leading-relaxed flex-1">
                        {p.shortDesc}
                      </p>
                      <div className="mt-5 flex items-center justify-between text-xs">
                        <span className="text-slate-400">品番 {p.code}</span>
                        <span className="inline-flex items-center gap-1 text-indigo-700 font-semibold group-hover:gap-2 transition-all">
                          詳細を見る
                          <span aria-hidden="true">&rarr;</span>
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
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
          <Link
            to="/salon-search"
            className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
          >
            取扱サロンを探す
          </Link>
        </div>
      </section>
    </>
  )
}
