import { Link, Navigate, useParams } from 'react-router-dom'
import { usePublicProducts } from '../../hooks/usePublicProducts.js'
import {
  recommendedForFor,
  usageSalonFor,
  usageHomeFor,
} from '../../data/products.js'

// 中部・最下部に配置する共通 CTA バナー（サロン検索は Coming Soon）
function FindSalonCTA({ productName }) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white px-6 sm:px-10 py-10 sm:py-12 text-center shadow-lg">
      <p className="text-amber-400 text-[11px] tracking-[0.25em] font-semibold mb-3">
        FIND A SALON
      </p>
      <h3 className="text-xl sm:text-2xl font-bold mb-3">
        お近くの取扱サロンを探す
      </h3>
      <p className="text-slate-300 text-sm leading-relaxed max-w-xl mx-auto mb-6">
        {productName}を実際に体験いただける、お近くの取扱サロンをご案内します。
      </p>
      <Link
        to="/salon-search"
        className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-white text-slate-900 font-semibold text-sm hover:bg-amber-50 transition-colors shadow-lg"
      >
        お近くの取扱サロンを探す
        <span className="text-[10px] font-bold tracking-wider text-amber-700 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">
          Coming Soon
        </span>
      </Link>
      <p className="mt-4 text-[11px] text-slate-400 tracking-wide">
        公開後すぐにご案内できるよう準備中です
      </p>
    </div>
  )
}

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

  // フォールバック付きで取り出し（CSV/Bカート未指定時はカテゴリ別デフォルト）
  const recommendedFor =
    product.recommendedFor && product.recommendedFor.length > 0
      ? product.recommendedFor
      : recommendedForFor(product.categoryKey)
  const usageSalon = product.usageSalon || usageSalonFor(product.categoryKey)
  const usageHome =
    product.usageHome || product.usage || usageHomeFor(product.categoryKey)

  // 関連商品：同カテゴリ優先で最大3件
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

      {/* ── ① 画像 + ② 商品名 + ③ キャッチコピー（説明・スペック含む基本情報ブロック） ── */}
      <section className="py-10 sm:py-14 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-14 items-start">
            {/* 画像 */}
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

            {/* 商品名・キャッチコピー・説明・スペック */}
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

              {/* ② 商品名 */}
              <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-900 leading-tight mb-4">
                {product.name}
              </h1>

              {/* ③ キャッチコピー */}
              {product.tagline && (
                <p className="text-indigo-700 font-semibold text-sm sm:text-base mb-6">
                  {product.tagline}
                </p>
              )}

              {product.description && (
                <p className="text-slate-600 text-sm sm:text-base leading-relaxed mb-8">
                  {product.description}
                </p>
              )}

              {/* スペック */}
              <dl className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm border-y border-slate-100 py-5 mb-7">
                <dt className="text-slate-400">品番</dt>
                <dd className="text-slate-800 font-medium">{product.code}</dd>
                <dt className="text-slate-400">容量</dt>
                <dd className="text-slate-800 font-medium">{product.unit || '—'}</dd>
                <dt className="text-slate-400">カテゴリ</dt>
                <dd className="text-slate-800 font-medium">{product.category}</dd>
              </dl>

              {/* ファーストビュー内 CTA（スクロールせずに到達） */}
              <div>
                <Link
                  to="/salon-search"
                  className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
                >
                  お近くの取扱サロンを探す
                  <span className="text-[10px] font-bold tracking-wider text-amber-200 bg-white/10 border border-amber-300/50 rounded-full px-2 py-0.5">
                    Coming Soon
                  </span>
                </Link>
                <p className="mt-3 text-xs text-slate-400 tracking-wide">
                  公開後すぐにご案内できるよう準備中です
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── ④ 特徴 ── */}
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

      {/* ── この商品がおすすめな方 ── */}
      {recommendedFor.length > 0 && (
        <section className="py-14 bg-white">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <p className="text-amber-600 text-[11px] tracking-[0.25em] font-semibold text-center mb-3">
              FOR WHOM
            </p>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 text-center mb-10">
              この商品がおすすめな方
            </h2>
            <ul className="space-y-3 max-w-2xl mx-auto">
              {recommendedFor.map((r, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 bg-slate-50 rounded-xl px-5 py-4"
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <p className="text-sm sm:text-base text-slate-700 leading-relaxed">{r}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ── ⑤ 使用シーン（サロン施術 / ホームケア） ── */}
      <section className="py-14 bg-slate-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-amber-600 text-[11px] tracking-[0.25em] font-semibold text-center mb-3">
            HOW TO USE
          </p>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 text-center mb-10">
            使用シーン
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* サロン施術 */}
            <div className="bg-white rounded-2xl p-7 shadow-sm border border-slate-100">
              <div className="flex items-center gap-3 mb-4">
                <span className="flex items-center justify-center w-10 h-10 rounded-full bg-indigo-100 text-indigo-700">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 11.25h18M5.25 6h13.5M3 16.5h18M9 21V11.25M15 21V11.25" />
                  </svg>
                </span>
                <div>
                  <p className="text-[10px] tracking-wider text-indigo-600 font-bold">SALON</p>
                  <h3 className="text-base font-bold text-slate-900">サロン施術</h3>
                </div>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">{usageSalon}</p>
            </div>

            {/* ホームケア */}
            <div className="bg-white rounded-2xl p-7 shadow-sm border border-slate-100">
              <div className="flex items-center gap-3 mb-4">
                <span className="flex items-center justify-center w-10 h-10 rounded-full bg-rose-100 text-rose-700">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.5 1.5 0 012.121 0L21.75 12M4.5 9.75v9.75A1.5 1.5 0 006 21h3v-6h6v6h3a1.5 1.5 0 001.5-1.5V9.75" />
                  </svg>
                </span>
                <div>
                  <p className="text-[10px] tracking-wider text-rose-600 font-bold">HOME</p>
                  <h3 className="text-base font-bold text-slate-900">ホームケア</h3>
                </div>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">{usageHome}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── ⑥ CTA 中部 ── */}
      <section className="py-12 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <FindSalonCTA productName={product.name} />
        </div>
      </section>

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

      {/* ── ⑥ CTA 最下部 ── */}
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <FindSalonCTA productName={product.name} />
        </div>
      </section>
    </>
  )
}
