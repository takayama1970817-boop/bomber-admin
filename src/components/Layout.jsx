import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useChatUnread } from '../hooks/useChatUnread.js'
// CompanyContext は案件管理ページ内で使用

const baseLink =
  'block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors'
const activeLink = 'bg-indigo-600 text-white'
const inactiveLink = 'text-gray-700 hover:bg-gray-100'
const subLink =
  'block rounded-lg pl-7 pr-3 py-2 text-[13px] font-medium transition-colors'

function Item({ to, label, onClick }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `${baseLink} ${isActive ? activeLink : inactiveLink}`
      }
      end
      onClick={onClick}
    >
      {label}
    </NavLink>
  )
}

function SubItem({ to, label, onClick }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `${subLink} ${isActive ? activeLink : inactiveLink}`
      }
      end
      onClick={onClick}
    >
      {label}
    </NavLink>
  )
}

function MenuGroup({ label, children, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false)
  const location = useLocation()
  // 子のパスがアクティブなら自動で開く
  const isChildActive = children?.some?.((c) => c?.props?.to && location.pathname === c.props.to)

  useEffect(() => {
    if (isChildActive) setOpen(true)
  }, [isChildActive])

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
      >
        {label}
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </div>
  )
}

export default function Layout() {
  const { user, profile, isAdmin, hasAccess, logout } = useAuth()
  const { totalUnread } = useChatUnread(user?.uid)
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  // ページ遷移時にメニューを閉じる
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  const closeMenu = () => setMenuOpen(false)

  const navItems = (
    <>
      <Item to="/dashboard" label="ダッシュボード" onClick={closeMenu} />
      {isAdmin && <Item to="/admin/dashboard-exec" label="経営ダッシュボード" onClick={closeMenu} />}
      {isAdmin && <Item to="/admin/customer-analytics" label="顧客分析" onClick={closeMenu} />}
      {isAdmin && <Item to="/admin/product-costs" label="原価マスタ" onClick={closeMenu} />}
      {(isAdmin || profile?.role === 'staff') && (
        <MenuGroup label="ERP（基幹）">
          <SubItem to="/admin/erp/orders" label="受注" onClick={closeMenu} />
          <SubItem to="/admin/erp/purchase-orders" label="発注" onClick={closeMenu} />
          <SubItem to="/admin/erp/inventory" label="在庫" onClick={closeMenu} />
          <SubItem to="/admin/erp/stock-ins" label="入庫" onClick={closeMenu} />
          <SubItem to="/admin/erp/shipments" label="出荷" onClick={closeMenu} />
        </MenuGroup>
      )}
      <Item to="/salons" label="サロン一覧" onClick={closeMenu} />
      <Item to="/dealers" label="代理店管理" onClick={closeMenu} />
      <Item to="/attendance" label="勤怠打刻" onClick={closeMenu} />
      <Item to="/attendance/history" label="勤怠履歴" onClick={closeMenu} />
      <Item
        to="/chat"
        onClick={closeMenu}
        label={
          <span className="flex items-center justify-between">
            チャット
            {totalUnread > 0 && (
              <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                {totalUnread}
              </span>
            )}
          </span>
        }
      />
      {hasAccess('calendar') && <Item to="/admin/calendar" label="カレンダー" onClick={closeMenu} />}
      {hasAccess('orders') && (
        <MenuGroup label="受注発注管理" defaultOpen>
          <SubItem to="/admin/projects" label="案件管理" onClick={closeMenu} />
          <SubItem to="/admin/bp-master" label="BPマスタ" onClick={closeMenu} />
        </MenuGroup>
      )}
      {hasAccess('inventory') && <Item to="/admin/inventory" label="在庫管理" onClick={closeMenu} />}
      {hasAccess('warehouse') && <Item to="/admin/warehouse" label="倉庫管理" onClick={closeMenu} />}
      {(isAdmin || profile?.role === 'staff') && <Item to="/settlements" label="取引精算" onClick={closeMenu} />}
      {hasAccess('kickback') && <Item to="/admin/kickback" label="KB清算" onClick={closeMenu} />}
      {isAdmin && (
        <MenuGroup label="請求書">
          <SubItem to="/admin/invoices" label="請求書管理" onClick={closeMenu} />
          <SubItem to="/admin/invoice-email-history" label="メール送信履歴" onClick={closeMenu} />
        </MenuGroup>
      )}
      {(isAdmin || profile?.role === 'staff') && (
        <MenuGroup label="FAX送信">
          <SubItem to="/admin/fax/send" label="新規送信" onClick={closeMenu} />
          <SubItem to="/admin/fax/history" label="送信履歴" onClick={closeMenu} />
        </MenuGroup>
      )}
      {hasAccess('users') && <Item to="/admin/users" label="スタッフ管理" onClick={closeMenu} />}
      {/* Bカート取り込みは不要（販売はBカートで直接処理） */}
      {hasAccess('receiptPreview') && <Item to="/admin/receipt-preview" label="領収書プレビュー" onClick={closeMenu} />}
      {isAdmin && (
        <MenuGroup label="メルマガ">
          <SubItem to="/admin/newsletter" label="メルマガ管理" onClick={closeMenu} />
          <SubItem to="/admin/readers" label="読者管理" onClick={closeMenu} />
        </MenuGroup>
      )}
      {(isAdmin || hasAccess('salonSales')) && (
        <MenuGroup label="サロン管理">
          {isAdmin && <SubItem to="/admin/salon-manage" label="サロンアカウント" onClick={closeMenu} />}
          {isAdmin && <SubItem to="/admin/salon-products" label="店販商品マスタ" onClick={closeMenu} />}
          {hasAccess('salonSales') && <SubItem to="/admin/salon-sales" label="サロン売上検索" onClick={closeMenu} />}
        </MenuGroup>
      )}
      {isAdmin && <Item to="/admin/dealer-docs" label="代理店資料管理" onClick={closeMenu} />}
      {isAdmin && (
        <MenuGroup label="研修管理">
          <SubItem to="/admin/training-applications" label="研修案件" onClick={closeMenu} />
          <SubItem to="/admin/training-types" label="研修種別マスタ" onClick={closeMenu} />
          <SubItem to="/admin/certified-instructors" label="認定インストラクター" onClick={closeMenu} />
        </MenuGroup>
      )}
      {isAdmin && (
        <MenuGroup label="設定">
          <SubItem to="/admin/general-settings" label="基本設定" onClick={closeMenu} />
          <SubItem to="/admin/kickback-settings" label="キックバック設定" onClick={closeMenu} />
          <SubItem to="/admin/settings" label="権限設定" onClick={closeMenu} />
        </MenuGroup>
      )}
    </>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      {/* === PC用サイドバー（md以上で表示） === */}
      <aside className="relative hidden w-60 shrink-0 flex-col border-r border-gray-200 bg-white md:flex">
        <div className="p-4 pb-2">
          <div className="text-lg font-bold text-gray-900">ロイヤルトラスト</div>
          <div className="text-xs text-gray-500">社内システム</div>
        </div>

        <nav className="flex-1 space-y-1 overflow-auto px-4 py-2">
          {navItems}
        </nav>

        <div className="border-t border-gray-100 p-4">
          <div className="mb-2 truncate text-xs text-gray-500">
            {profile?.name || profile?.email}
            <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">
              {profile?.role}
            </span>
          </div>
          <button
            onClick={logout}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            ログアウト
          </button>
        </div>
      </aside>

      {/* === スマホ用ヘッダー + ハンバーガーメニュー（md未満で表示） === */}
      <div className="flex flex-1 flex-col overflow-hidden md:contents">
        {/* スマホヘッダー */}
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 md:hidden">
          <div>
            <div className="text-base font-bold text-gray-900">ロイヤルトラスト</div>
            <div className="text-[10px] text-gray-400">社内システム</div>
          </div>
          <div className="flex items-center gap-3">
            {totalUnread > 0 && (
              <NavLink to="/chat" className="relative" onClick={closeMenu}>
                <svg className="h-6 w-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {totalUnread}
                </span>
              </NavLink>
            )}
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
          </div>
        </header>

        {/* スマホ用スライドメニュー */}
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/30 md:hidden"
              onClick={closeMenu}
            />
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
                  <span className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">
                    {profile?.role}
                  </span>
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
  )
}
