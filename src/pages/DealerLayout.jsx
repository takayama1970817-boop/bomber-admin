import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'

const baseLink = 'block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors'
const activeLink = 'bg-indigo-600 text-white'
const inactiveLink = 'text-gray-700 hover:bg-gray-100'

function Item({ to, label, onClick, end }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `${baseLink} ${isActive ? activeLink : inactiveLink}`}
      end={end}
      onClick={onClick}
    >
      {label}
    </NavLink>
  )
}

export default function DealerLayout() {
  const { profile, logout, isImpersonating, impersonation, isDealerStaff } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  const closeMenu = () => setMenuOpen(false)
  const companyName = profile?.companyName || ''

  const navItems = (
    <>
      <Item to="/dealer" label="ダッシュボード" onClick={closeMenu} end />
      <Item to="/dealer/dashboard-exec" label="経営ダッシュボード" onClick={closeMenu} />
      <Item to="/dealer/salons" label="所属サロン管理" onClick={closeMenu} />
      <Item to="/dealer/chat" label="チャット" onClick={closeMenu} />
      <Item to="/dealer/documents" label="資料ダウンロード" onClick={closeMenu} />
    </>
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {isImpersonating && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-red-600 px-4 py-2 text-xs font-bold text-white md:text-sm">
          <span>
            ⚠️ 閲覧モード：{profile?.companyName || '代理店'} として表示中
            {impersonation?.originalAdminEmail && (
              <span className="ml-2 font-normal opacity-90">
                （管理者: {impersonation.originalAdminEmail}）
              </span>
            )}
            <span className="ml-2 font-normal opacity-90">※書き込み操作はブロックされます</span>
          </span>
          <button
            onClick={logout}
            className="rounded border border-white bg-white/10 px-3 py-1 text-xs font-bold text-white hover:bg-white/20"
          >
            管理者に戻る（ログアウト）
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
      {/* PC用サイドバー */}
      <aside className="relative hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
        <div className="p-4 pb-2">
          <div className="text-lg font-bold text-gray-900">VAVITTE</div>
          <div className="text-xs text-gray-500">代理店ポータル</div>
          {companyName && (
            <div className="mt-1 text-xs font-medium text-indigo-600">{companyName} 様</div>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-auto px-4 py-2">
          {navItems}
        </nav>

        <div className="border-t border-gray-100 p-4">
          <div className="mb-2 truncate text-xs text-gray-500">
            {profile?.name || profile?.email}
            {isDealerStaff && (
              <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                スタッフ
              </span>
            )}
          </div>
          <button
            onClick={logout}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            ログアウト
          </button>
        </div>
      </aside>

      {/* スマホ用ヘッダー + ハンバーガーメニュー */}
      <div className="flex flex-1 flex-col overflow-hidden md:contents">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 md:hidden">
          <div>
            <div className="text-base font-bold text-gray-900">VAVITTE</div>
            <div className="text-[10px] text-gray-400">
              代理店ポータル{companyName ? ` — ${companyName}` : ''}
            </div>
          </div>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"
          >
            {menuOpen ? (
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </header>

        {/* スマホスライドメニュー */}
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={closeMenu} />
            <div className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col bg-white shadow-xl md:hidden">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <div className="text-sm font-bold text-gray-700">メニュー</div>
                <button onClick={closeMenu} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <nav className="flex-1 space-y-1 overflow-auto px-4 py-3">
                {navItems}
              </nav>
              <div className="border-t border-gray-100 p-4">
                <div className="mb-2 truncate text-xs text-gray-500">
                  {profile?.name || profile?.email}
                </div>
                <button
                  onClick={() => { closeMenu(); logout() }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  ログアウト
                </button>
              </div>
            </div>
          </>
        )}

        {/* メインコンテンツ */}
        <main className="flex-1 overflow-auto p-4 md:p-8">
          <Outlet />
        </main>
      </div>
      </div>
    </div>
  )
}
