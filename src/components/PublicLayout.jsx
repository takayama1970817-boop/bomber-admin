import { useState, useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'

const navLinks = [
  { to: '/products', label: '商品紹介' },
  { to: '/salon-search', label: 'サロン検索' },
  { to: '/partner', label: '代理店募集' },
  { to: '/login', label: 'ログイン' },
]

export default function PublicLayout() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // メニューを閉じる（ページ遷移時）
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* ── ヘッダー ── */}
      <header
        className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-white/80 backdrop-blur-md shadow-sm'
            : 'bg-white'
        }`}
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between px-4 sm:px-6 lg:px-8 h-16">
          {/* ロゴ */}
          <Link to="/" className="flex items-center gap-2 select-none">
            <span className="text-xl font-bold tracking-widest text-slate-900">
              ROYAL TRUST
            </span>
            <span className="hidden sm:inline text-[10px] tracking-wider text-amber-600 font-semibold border border-amber-400 rounded px-1.5 py-0.5 leading-none">
              VAVITTE
            </span>
          </Link>

          {/* デスクトップナビ */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className={`text-sm tracking-wide transition-colors hover:text-indigo-600 ${
                  location.pathname === l.to
                    ? 'text-indigo-700 font-semibold'
                    : 'text-slate-700'
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* モバイルハンバーガー */}
          <button
            className="md:hidden flex flex-col gap-1.5 p-2"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="メニュー"
          >
            <span
              className={`block h-0.5 w-6 bg-slate-800 transition-transform ${
                menuOpen ? 'translate-y-2 rotate-45' : ''
              }`}
            />
            <span
              className={`block h-0.5 w-6 bg-slate-800 transition-opacity ${
                menuOpen ? 'opacity-0' : ''
              }`}
            />
            <span
              className={`block h-0.5 w-6 bg-slate-800 transition-transform ${
                menuOpen ? '-translate-y-2 -rotate-45' : ''
              }`}
            />
          </button>
        </div>

        {/* モバイルメニュー */}
        {menuOpen && (
          <nav className="md:hidden bg-white border-t border-slate-100 shadow-lg">
            {navLinks.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="block px-6 py-3 text-sm text-slate-700 hover:bg-slate-50 hover:text-indigo-600 transition-colors"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      {/* ── メインコンテンツ ── */}
      <main className="flex-1 pt-16">
        <Outlet />
      </main>

      {/* ── フッター ── */}
      <footer className="bg-slate-900 text-slate-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {/* ブランド */}
            <div>
              <p className="text-white font-bold tracking-widest text-lg mb-2">
                ROYAL TRUST
              </p>
              <p className="text-xs text-amber-400 tracking-wider mb-4">
                VAVITTE - バビッテ
              </p>
              <p className="text-xs leading-relaxed text-slate-400">
                プロフェッショナルのための
                <br />
                サロン専売化粧品ブランド
              </p>
            </div>

            {/* 商品 */}
            <div>
              <p className="text-white text-sm font-semibold mb-3">商品</p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link to="/products" className="hover:text-white transition-colors">
                    商品一覧
                  </Link>
                </li>
                <li>
                  <Link to="/salon-search" className="hover:text-white transition-colors">
                    取扱サロン検索
                  </Link>
                </li>
              </ul>
            </div>

            {/* パートナー */}
            <div>
              <p className="text-white text-sm font-semibold mb-3">パートナー</p>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link to="/partner" className="hover:text-white transition-colors">
                    代理店募集
                  </Link>
                </li>
                <li>
                  <Link to="/partner" className="hover:text-white transition-colors">
                    サロン導入
                  </Link>
                </li>
              </ul>
            </div>

            {/* 会社情報 */}
            <div>
              <p className="text-white text-sm font-semibold mb-3">運営会社</p>
              <p className="text-sm leading-relaxed">
                ロイヤルトラスト株式会社
                <br />
                <span className="text-xs text-slate-400">Royal Trust Co., Ltd.</span>
              </p>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
            <p>&copy; {new Date().getFullYear()} ロイヤルトラスト株式会社 All rights reserved.</p>
            <div className="flex gap-4">
              <Link to="/partner" className="hover:text-slate-300 transition-colors">
                お問い合わせ
              </Link>
              <Link to="/login" className="hover:text-slate-300 transition-colors">
                管理者ログイン
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
