import { Link, Navigate, useParams } from 'react-router-dom'
import { usePublicProducts } from '../../hooks/usePublicProducts.js'

export default function ProductDetailPage() {
  const { slug } = useParams()
  const { products, loading } = usePublicProducts()

  if (loading) {
    return (
      <section className="py-24 text-center">
        <div className="inline-block w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </section>
    )
  }

  const product = products.find((p) => p.slug === slug) || null
  if (!product) {
    return <Navigate to="/products" replace />
  }

  // 関連商品：同カテゴリ or カテゴリ横断で上から最大3件
  const related = products
    .filter((p) => p.slug !== product.slug)
    .sort((a) => (a.categoryKey === product.categoryKey ? -1 : 1))
    .slice(0, 3)

  return (
    <>
      {/* パンくず */}
      <nav className="bg-white border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 text-xs text-slate-500">
          <Link to="/" className="hover:text-indigo-600">ホーム</Link>
          <span className="mx-2 text-slate-300">/</span>
          <Link to="/products" className="hover:text-indigo-600">商品一覧</Link>
          <span className="mx-2 text-slate-300">/</span>
          <span className="text-slate-700">{product.name}</span>
        </div>
      </nav>

      {/* 本体 */}
      <section className="py-10 sm:py-14 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-start">
            {/* ビジュアル */}
            <div
              className={`aspect-square rounded-3xl bg-gradient-to-br ${product.gradient} relative overflow-hidden`}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <svg
                  viewBox="0 0 48 48"
                  fill="none"
                  className="w-24 h-24 text-white/60"
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
              <span className="absolute top-4 right-4 bg-white/20 backdrop-blur text-white text-[10px] font-bold tracking-wider px-3 py-1 rounded-full">
                サロン専売品
              </span>
            </div>

            {/* 情報 */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[11px] tracking-wider text-indigo-600 font-semibold">
                  {product.category}
                </span>
                {product.badge && (
                  <span className="text-[10px] font-bold tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
                    {product.badge}
                  </span>
                )}
              </div>

              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 leading-tight mb-4">
                {product.name}
              </h1>

              {product.tagline && (
                <p className="text-indigo-700 font-semibold text-sm sm:text-base mb-6">
                  {product.tagline}
                </p>
              )}

              <p className="text-slate-600 text-sm sm:text-base leading-relaxed mb-8">
                {product.description}
              </p>

              {/* スペック */}
              <dl className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm border-y border-slate-100 py-5 mb-8">
                <dt className="text-slate-400">品番</dt>
                <dd className="text-slate-800 font-medium">{product.code}</dd>
                <dt className="text-slate-400">容量</dt>
                <dd className="text-slate-800 font-medium">{product.unit || '—'}</dd>
                <dt className="text-slate-400">カテゴリ</dt>
                <dd className="text-slate-800 font-medium">{product.category}</dd>
              </dl>

              {/* CTA */}
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  to="/salon-search"
                  className="inline-flex items-center justify-center px-6 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
                >
                  取扱サロンを探す
                </Link>
                <Link
                  to="/products"
                  className="inline-flex items-center justify-center px-6 py-3 rounded-full border border-slate-300 text-slate-700 font-semibold text-sm hover:border-indigo-300 hover:text-indigo-700 transition-colors"
                >
                  商品一覧へ戻る
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 特長 */}
      {product.features?.length > 0 && (
        <section className="py-14 bg-slate-50">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 text-center mb-10">
              商品の特長
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {product.features.map((f, i) => (
                <div
                  key={i}
                  className="bg-white rounded-xl px-5 py-4 flex items-start gap-3 shadow-sm"
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex-shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <p className="text-sm text-slate-700 leading-relaxed">{f}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 使用方法 */}
      {product.usage && (
        <section className="py-14 bg-white">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 text-center mb-6">
              ご使用方法
            </h2>
            <p className="text-slate-600 text-sm sm:text-base leading-relaxed text-center">
              {product.usage}
            </p>
          </div>
        </section>
      )}

      {/* 関連商品 */}
      {related.length > 0 && (
        <section className="py-16 bg-slate-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 text-center mb-10">
              その他のおすすめ
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              {related.map((p) => (
                <Link
                  key={p.slug}
                  to={`/products/${p.slug}`}
                  className="group bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all"
                >
                  <div className={`h-36 bg-gradient-to-br ${p.gradient}`} />
                  <div className="p-5">
                    <p className="text-[10px] tracking-wider text-indigo-600 font-semibold mb-1">
                      {p.category}
                    </p>
                    <h3 className="text-base font-bold text-slate-900 group-hover:text-indigo-700 transition-colors">
                      {p.name}
                    </h3>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  )
}
