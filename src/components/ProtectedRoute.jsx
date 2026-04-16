import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'

export default function ProtectedRoute({ children, requireRole, requireFeature, allowDealer, allowWarehouse, allowSalon }) {
  const { user, profile, loading, hasAccess } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">
        読み込み中...
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // dealer は専用画面以外アクセス不可
  if (profile?.role === 'dealer' && !allowDealer) {
    return <Navigate to="/dealer" replace />
  }

  // warehouse は専用画面以外アクセス不可
  if (profile?.role === 'warehouse' && !allowWarehouse) {
    return <Navigate to="/warehouse" replace />
  }

  // salon は専用画面以外アクセス不可
  if (profile?.role === 'salon' && !allowSalon) {
    return <Navigate to="/salon" replace />
  }

  // 機能単位の権限チェック（権限設定画面で管理）
  if (requireFeature) {
    if (!hasAccess(requireFeature)) {
      return <Navigate to="/dashboard" replace />
    }
  }

  // 旧方式のロールチェック（後方互換）
  if (requireRole) {
    const allowed = Array.isArray(requireRole) ? requireRole : [requireRole]
    const role = profile?.role
    const effectiveMatch = allowed.includes(role) || (role === 'master' && allowed.includes('admin'))
    if (!effectiveMatch) {
      return <Navigate to="/dashboard" replace />
    }
  }

  return children
}
