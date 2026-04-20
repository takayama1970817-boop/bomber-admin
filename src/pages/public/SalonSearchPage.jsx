import { Link } from 'react-router-dom'

const upcomingFeatures = [
  {
    title: '都道府県・エリア検索',
    desc: 'お住まいの地域や訪問予定先から、最寄りの VAVITTE 取扱サロンをすぐに見つけられます。',
  },
  {
    title: 'こだわり条件で絞り込み',
    desc: 'メニュー（フェイシャル / ボディ）、対応時間帯、施術メニューなど、希望に合わせて絞り込み可能です。',
  },
  {
    title: 'サロン詳細ページ',
    desc: '取扱商品・施術メニュー・サロンの雰囲気まで、ご予約前に十分な情報でサロン選びができます。',
  },
  {
    title: 'お気に入り / 地図連携',
    desc: '気になったサロンを保存・地図から位置確認が可能。スムーズな来店体験をサポートします。',
  },
]

export default function SalonSearchPage() {
  return (
    <>
      {/* ── ヘッダー ── */}
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

      {/* ── Coming Soon メッセージ ── */}
      <section className="py-20 sm:py-24 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
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

          <span className="inline-block text-[10px] tracking-[0.3em] font-bold text-amber-800 bg-amber-50 border border-amber-300 rounded-full px-4 py-1.5 mb-6">
            COMING SOON
          </span>

          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-6">
            サロン検索機能は準備中です
          </h2>

          <p className="text-slate-600 text-sm sm:text-base leading-relaxed mb-4">
            VAVITTE 製品をお取扱いいただいているサロンを、
            <br className="hidden sm:block" />
            地域・メニュー・施術内容など多彩な条件でお探しいただける検索機能を
            <br className="hidden sm:block" />
            現在開発中です。
          </p>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed">
            お客様とサロンの最良のマッチングを実現するため、
            <br className="hidden sm:block" />
            情報の正確性と使いやすさを丁寧に整えておりますので、
            <br className="hidden sm:block" />
            公開まで今しばらくお待ちください。
          </p>
        </div>
      </section>

      {/* ── 予定機能 ── */}
      <section className="py-20 bg-slate-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-amber-600 text-[11px] tracking-[0.25em] font-semibold mb-3">
              UPCOMING FEATURES
            </p>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
              公開予定の機能
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {upcomingFeatures.map((f, i) => (
              <div
                key={i}
                className="bg-white rounded-2xl p-6 sm:p-7 shadow-sm border border-slate-100 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start gap-4">
                  <span className="flex items-center justify-center w-9 h-9 rounded-full bg-indigo-50 text-indigo-700 flex-shrink-0">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6v12m6-6H6"
                      />
                    </svg>
                  </span>
                  <div>
                    <h3 className="font-bold text-slate-900 mb-2">{f.title}</h3>
                    <p className="text-sm text-slate-500 leading-relaxed">
                      {f.desc}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 代替導線 ── */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 mb-3">
              それまでの間、こちらもご覧ください
            </h2>
            <p className="text-slate-500 text-sm">
              公開までの間、VAVITTE の世界観や製品について知っていただく入り口をご用意しています
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* 商品を見る */}
            <Link
              to="/products"
              className="group bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl p-7 border border-indigo-100 hover:border-indigo-300 hover:shadow-lg transition-all"
            >
              <div className="flex items-center gap-3 mb-3">
                <span className="flex items-center justify-center w-10 h-10 rounded-full bg-indigo-600 text-white">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                  </svg>
                </span>
                <h3 className="text-base font-bold text-slate-900 group-hover:text-indigo-700 transition-colors">
                  商品を見る
                </h3>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                VAVITTE の主力商品ラインナップをご紹介。カテゴリ別・キーワード検索にも対応しています。
              </p>
              <p className="mt-4 text-sm font-semibold text-indigo-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                商品一覧へ
                <span aria-hidden="true">&rarr;</span>
              </p>
            </Link>

            {/* ホームへ戻る */}
            <Link
              to="/"
              className="group bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl p-7 border border-amber-100 hover:border-amber-300 hover:shadow-lg transition-all"
            >
              <div className="flex items-center gap-3 mb-3">
                <span className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-600 text-white">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.5 1.5 0 012.121 0L21.75 12M4.5 9.75v9.75A1.5 1.5 0 006 21h3.75M9 21h6m0 0v-6M15 21h3.75a1.5 1.5 0 001.5-1.5V9.75" />
                  </svg>
                </span>
                <h3 className="text-base font-bold text-slate-900 group-hover:text-amber-700 transition-colors">
                  ブランドについて
                </h3>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                VAVITTE の思想・品質へのこだわり・海外展開など、ブランドの全体像をホームページでご覧いただけます。
              </p>
              <p className="mt-4 text-sm font-semibold text-amber-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                ホームへ
                <span aria-hidden="true">&rarr;</span>
              </p>
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
