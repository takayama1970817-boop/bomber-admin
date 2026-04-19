import { Link } from 'react-router-dom'

export default function SalonSearchPage() {
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

      {/* Coming Soon */}
      <section className="py-24 sm:py-32 bg-slate-50 min-h-[60vh] flex items-center">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 mb-8 shadow-lg">
            <svg
              className="w-10 h-10 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
              />
            </svg>
          </div>

          <p className="text-amber-600 text-xs tracking-[0.3em] font-semibold mb-4">
            COMING SOON
          </p>

          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-6">
            サロン検索機能は準備中です
          </h2>

          <p className="text-slate-600 text-sm sm:text-base leading-relaxed mb-10">
            現在、全国のVAVITTE製品取扱サロンを
            <br className="hidden sm:block" />
            より使いやすく検索いただけるよう、新しい検索機能を開発中です。
            <br className="hidden sm:block" />
            公開までいましばらくお待ちください。
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/products"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full bg-indigo-700 text-white font-semibold text-sm hover:bg-indigo-800 transition-colors shadow-lg"
            >
              商品を見る
            </Link>
            <Link
              to="/"
              className="inline-flex items-center justify-center px-8 py-3 rounded-full border border-slate-300 text-slate-700 font-semibold text-sm hover:border-indigo-300 hover:text-indigo-700 transition-colors"
            >
              ホームへ戻る
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
