/**
 * ERP 論理名 ↔ 物理名マップ
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §2
 *
 * ⚠️ 画面・lib コードから物理名文字列（'erp_orders' 等）の直書き禁止。
 *    必ず ERP_COLLECTIONS.Order 経由で参照する。
 */

export const ERP_COLLECTIONS = {
  // === Phase 1 実装対象 ===
  Order: 'erp_orders',
  PurchaseOrder: 'erp_purchase_orders',
  Inventory: 'erp_inventory',
  StockIn: 'erp_stock_ins',
  Shipment: 'erp_shipments',
  ExternalRaw: 'erp_external_raw',
  AuditLog: 'audit_logs',

  // === Phase 1 設計のみ（物理的には未使用） ===
  Project: 'erp_projects',
  Quotation: 'erp_quotations',
  ProductionOrder: 'erp_production_orders',
  ProductionResult: 'erp_production_results',
  Invoice: 'erp_invoices',
  Payment: 'erp_payments',
}

/** Phase 1 で書き込みが発生する collection */
export const PHASE1_WRITABLE = [
  ERP_COLLECTIONS.Order,
  ERP_COLLECTIONS.PurchaseOrder,
  ERP_COLLECTIONS.Inventory,
  ERP_COLLECTIONS.StockIn,
  ERP_COLLECTIONS.Shipment,
  ERP_COLLECTIONS.ExternalRaw,
  ERP_COLLECTIONS.AuditLog,
]

/** 物理削除禁止の collection（rules で allow delete: if false） */
export const IMMUTABLE_COLLECTIONS = [
  ERP_COLLECTIONS.ProductionResult,
  ERP_COLLECTIONS.StockIn,
  ERP_COLLECTIONS.Shipment,
  ERP_COLLECTIONS.Invoice,
  ERP_COLLECTIONS.Payment,
  ERP_COLLECTIONS.ExternalRaw,
  ERP_COLLECTIONS.AuditLog,
]

/** 共通フィールド名（全 collection で必須） */
export const COMMON_FIELDS = [
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  'company',
  'version',
]
