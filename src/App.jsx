import { Routes, Route, Navigate } from 'react-router-dom'
import Chat from './pages/Chat.jsx'
import Login from './pages/Login.jsx'
import PublicReceipt from './pages/PublicReceipt.jsx'
import Dashboard from './pages/Dashboard.jsx'
import ExecDashboard from './pages/ExecDashboard.jsx'
import ProductCosts from './pages/ProductCosts.jsx'
import ErpOrders from './pages/ErpOrders.jsx'
import ErpPurchaseOrders from './pages/ErpPurchaseOrders.jsx'
import ErpInventory from './pages/ErpInventory.jsx'
import ErpStockIns from './pages/ErpStockIns.jsx'
import ErpShipments from './pages/ErpShipments.jsx'
import DealerExecDashboard from './pages/DealerExecDashboard.jsx'
import ProductRanking from './pages/ProductRanking.jsx'
import SalonRanking from './pages/SalonRanking.jsx'
import CustomerAnalytics from './pages/CustomerAnalytics.jsx'
import Salons from './pages/Salons.jsx'
import SalonDetail from './pages/SalonDetail.jsx'
import Attendance from './pages/Attendance.jsx'
import AttendanceHistory from './pages/AttendanceHistory.jsx'
import AdminUsers from './pages/AdminUsers.jsx'
import Dealers from './pages/Dealers.jsx'
import DealerLogin from './pages/DealerLogin.jsx'
import DealerLayout from './pages/DealerLayout.jsx'
import DealerDashboard from './pages/DealerDashboard.jsx'
import DealerSalons from './pages/DealerSalons.jsx'
import DealerOrders from './pages/DealerOrders.jsx'
import DealerInvoices from './pages/DealerInvoices.jsx'
import DealerKickbacks from './pages/DealerKickbacks.jsx'
import DealerChat from './pages/DealerChat.jsx'
import DealerDocuments from './pages/DealerDocuments.jsx'
import DealerDocManage from './pages/DealerDocManage.jsx'
import SalonLogin from './pages/SalonLogin.jsx'
import SalonLayout from './pages/SalonLayout.jsx'
import SalonDashboard from './pages/SalonDashboard.jsx'
import SalonChat from './pages/SalonChat.jsx'
import SalonDocuments from './pages/SalonDocuments.jsx'
import SalonCustomers from './pages/SalonCustomers.jsx'
import SalonReservations from './pages/SalonReservations.jsx'
import SalonProductsAdmin from './pages/SalonProductsAdmin.jsx'
import SalonManage from './pages/SalonManage.jsx'
import SalonSales from './pages/SalonSales.jsx'
import KickbackManage from './pages/KickbackManage.jsx'
import SettlementManage from './pages/SettlementManage.jsx'
import Inventory from './pages/Inventory.jsx'
import WarehouseView from './pages/WarehouseView.jsx'
import WarehousePortal from './pages/WarehousePortal.jsx'
import WarehouseLogin from './pages/WarehouseLogin.jsx'
import BcartImport from './pages/BcartImport.jsx'
import ReceiptPreview from './pages/ReceiptPreview.jsx'
import OrderManage from './pages/OrderManage.jsx'
import ProjectManage from './pages/ProjectManage.jsx'
import BpMaster from './pages/BpMaster.jsx'
import Calendar from './pages/Calendar.jsx'
import GeneralSettings from './pages/GeneralSettings.jsx'
import InvoiceManage from './pages/InvoiceManage.jsx'
import PurchaseManage from './pages/PurchaseManage.jsx'
import QuotationManage from './pages/QuotationManage.jsx'
import KickbackSettings from './pages/KickbackSettings.jsx'
import PermissionSettings from './pages/PermissionSettings.jsx'
import NewsletterManage from './pages/NewsletterManage.jsx'
import ReaderManage from './pages/ReaderManage.jsx'
import TrainingTypesAdmin from './pages/TrainingTypesAdmin.jsx'
import TrainingApplications from './pages/TrainingApplications.jsx'
import TrainingApplicationDetail from './pages/TrainingApplicationDetail.jsx'
import ProtectedRoute from './components/ProtectedRoute.jsx'
import Layout from './components/Layout.jsx'
import { CompanyProvider } from './contexts/CompanyContext.jsx'
import PublicLayout from './components/PublicLayout.jsx'
import HomePage from './pages/public/HomePage.jsx'
import ProductsPage from './pages/public/ProductsPage.jsx'
import SalonSearchPage from './pages/public/SalonSearchPage.jsx'
import PartnerPage from './pages/public/PartnerPage.jsx'
import NewsletterSubscribe from './pages/public/NewsletterSubscribe.jsx'
import NewsletterUnsubscribe from './pages/public/NewsletterUnsubscribe.jsx'

const isTestEnv = import.meta.env.VITE_ENV === 'test'

export default function App() {
  return (
    <>
      {isTestEnv && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#dc2626', color: '#fff', textAlign: 'center',
          padding: '4px 0', fontSize: '12px', fontWeight: 'bold',
          letterSpacing: '2px'
        }}>
          テスト環境 — 本番データには影響しません
        </div>
      )}
      {isTestEnv && <div style={{ height: '28px' }} />}
      <Routes>
      {/* 公開サイト */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/salon-search" element={<SalonSearchPage />} />
        <Route path="/partner" element={<PartnerPage />} />
        <Route path="/newsletter/subscribe" element={<NewsletterSubscribe />} />
        <Route path="/newsletter/unsubscribe" element={<NewsletterUnsubscribe />} />
      </Route>

      <Route path="/login" element={<Login />} />
      <Route path="/dealer-login" element={<DealerLogin />} />
      <Route path="/salon-login" element={<SalonLogin />} />
      <Route path="/receipt" element={<PublicReceipt />} />
      <Route path="/warehouse-login" element={<WarehouseLogin />} />

      <Route
        path="/warehouse"
        element={
          <ProtectedRoute allowWarehouse>
            <WarehousePortal />
          </ProtectedRoute>
        }
      />

      {/* サロンポータル（レイアウト付き） */}
      <Route
        path="/salon"
        element={
          <ProtectedRoute allowSalon>
            <SalonLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<SalonDashboard />} />
        <Route path="customers" element={<SalonCustomers />} />
        <Route path="reservations" element={<SalonReservations />} />
        <Route path="chat" element={<SalonChat />} />
        <Route path="documents" element={<SalonDocuments />} />
      </Route>

      {/* 代理店ポータル（レイアウト付き） */}
      <Route
        path="/dealer"
        element={
          <ProtectedRoute allowDealer>
            <DealerLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DealerDashboard />} />
        <Route path="dashboard-exec" element={<DealerExecDashboard />} />
        <Route path="salons" element={<DealerSalons />} />
        <Route path="orders" element={<DealerOrders />} />
        <Route path="invoices" element={<DealerInvoices />} />
        <Route path="kickbacks" element={<DealerKickbacks />} />
        <Route path="chat" element={<DealerChat />} />
        <Route path="documents" element={<DealerDocuments />} />
      </Route>

      <Route
        element={
          <ProtectedRoute>
            <CompanyProvider>
              <Layout />
            </CompanyProvider>
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/admin/dashboard-exec" element={<ProtectedRoute requireRole="admin"><ExecDashboard /></ProtectedRoute>} />
        <Route path="/admin/product-ranking" element={<ProtectedRoute requireRole="admin"><ProductRanking /></ProtectedRoute>} />
        <Route path="/admin/salon-ranking" element={<ProtectedRoute requireRole="admin"><SalonRanking /></ProtectedRoute>} />
        <Route path="/admin/customer-analytics" element={<ProtectedRoute requireRole="admin"><CustomerAnalytics /></ProtectedRoute>} />
        <Route path="/admin/product-costs" element={<ProtectedRoute requireRole="admin"><ProductCosts /></ProtectedRoute>} />
        <Route path="/admin/erp/orders" element={<ProtectedRoute requireRole={['admin', 'staff']}><ErpOrders /></ProtectedRoute>} />
        <Route path="/admin/erp/purchase-orders" element={<ProtectedRoute requireRole={['admin', 'staff']}><ErpPurchaseOrders /></ProtectedRoute>} />
        <Route path="/admin/erp/inventory" element={<ProtectedRoute requireRole={['admin', 'staff']}><ErpInventory /></ProtectedRoute>} />
        <Route path="/admin/erp/stock-ins" element={<ProtectedRoute requireRole={['admin', 'staff']}><ErpStockIns /></ProtectedRoute>} />
        <Route path="/admin/erp/shipments" element={<ProtectedRoute requireRole={['admin', 'staff']}><ErpShipments /></ProtectedRoute>} />
        <Route path="/salons" element={<Salons />} />
        <Route path="/salons/:id" element={<SalonDetail />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/attendance/history" element={<AttendanceHistory />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/dealers" element={<Dealers />} />
        <Route path="/admin/projects" element={<ProtectedRoute requireFeature="orders"><ProjectManage /></ProtectedRoute>} />
        <Route path="/admin/bp-master" element={<ProtectedRoute requireFeature="orders"><BpMaster /></ProtectedRoute>} />
        <Route path="/admin/orders" element={<ProtectedRoute requireFeature="orders"><OrderManage /></ProtectedRoute>} />
        <Route path="/admin/purchases" element={<ProtectedRoute requireFeature="orders"><PurchaseManage /></ProtectedRoute>} />
        <Route path="/admin/quotations" element={<ProtectedRoute requireFeature="orders"><QuotationManage /></ProtectedRoute>} />
        <Route path="/admin/inventory" element={<ProtectedRoute requireFeature="inventory"><Inventory /></ProtectedRoute>} />
        <Route path="/admin/warehouse" element={<ProtectedRoute requireFeature="warehouse"><WarehouseView /></ProtectedRoute>} />
        <Route path="/admin/kickback" element={<ProtectedRoute requireFeature="kickback"><KickbackManage /></ProtectedRoute>} />
        <Route path="/settlements" element={<ProtectedRoute requireRole={['admin', 'staff']}><SettlementManage /></ProtectedRoute>} />
        <Route path="/admin/invoices" element={<ProtectedRoute requireRole="admin"><InvoiceManage /></ProtectedRoute>} />
        <Route path="/admin/users" element={<ProtectedRoute requireFeature="users"><AdminUsers /></ProtectedRoute>} />
        <Route path="/admin/bcart-import" element={<ProtectedRoute requireFeature="bcartImport"><BcartImport /></ProtectedRoute>} />
        <Route path="/admin/receipt-preview" element={<ProtectedRoute requireFeature="receiptPreview"><ReceiptPreview /></ProtectedRoute>} />
        <Route path="/admin/calendar" element={<ProtectedRoute requireFeature="calendar"><Calendar /></ProtectedRoute>} />
        <Route path="/admin/salon-manage" element={<ProtectedRoute requireRole="admin"><SalonManage /></ProtectedRoute>} />
        <Route path="/admin/salon-sales" element={<ProtectedRoute requireFeature="salonSales"><SalonSales /></ProtectedRoute>} />
        <Route path="/admin/salon-products" element={<ProtectedRoute requireRole="admin"><SalonProductsAdmin /></ProtectedRoute>} />
        <Route path="/admin/dealer-docs" element={<ProtectedRoute requireRole="admin"><DealerDocManage /></ProtectedRoute>} />
        <Route path="/admin/general-settings" element={<ProtectedRoute requireRole="admin"><GeneralSettings /></ProtectedRoute>} />
        <Route path="/admin/kickback-settings" element={<ProtectedRoute requireRole="admin"><KickbackSettings /></ProtectedRoute>} />
        <Route path="/admin/settings" element={<ProtectedRoute requireRole="admin"><PermissionSettings /></ProtectedRoute>} />
        <Route path="/admin/newsletter" element={<ProtectedRoute requireRole="admin"><NewsletterManage /></ProtectedRoute>} />
        <Route path="/admin/readers" element={<ProtectedRoute requireRole="admin"><ReaderManage /></ProtectedRoute>} />
        <Route path="/admin/training-types" element={<ProtectedRoute requireRole="admin"><TrainingTypesAdmin /></ProtectedRoute>} />
        <Route path="/admin/training-applications" element={<ProtectedRoute requireRole="admin"><TrainingApplications /></ProtectedRoute>} />
        <Route path="/admin/training-applications/:id" element={<ProtectedRoute requireRole="admin"><TrainingApplicationDetail /></ProtectedRoute>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
