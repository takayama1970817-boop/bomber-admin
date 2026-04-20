/**
 * ERP ステータス遷移マシン
 *
 * 設計書: docs/04_ERP_DATA_MODEL.md §4
 *
 * 各ステータスは独立管理（単一ステータスで全工程を回さない）。
 * ここでは遷移表を定義し、画面・保存処理から assertTransition() で検証する。
 */

// =====================================================================
// OrderStatus
// =====================================================================
export const ORDER_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  PARTIALLY_ALLOCATED: 'partially_allocated',
  FULLY_ALLOCATED: 'fully_allocated',
  PARTIALLY_SHIPPED: 'partially_shipped',
  SHIPPED: 'shipped',
  COMPLETED: 'completed',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
}

const ORDER_TRANSITIONS = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['partially_allocated', 'fully_allocated', 'cancelled'],
  partially_allocated: ['fully_allocated', 'partially_shipped', 'cancelled'],
  fully_allocated: ['partially_shipped', 'shipped', 'cancelled'],
  partially_shipped: ['shipped', 'cancelled'],
  shipped: ['completed', 'returned'],
  completed: ['returned'],
  returned: [],
  cancelled: [],
}

// =====================================================================
// PurchaseStatus
// =====================================================================
export const PURCHASE_STATUS = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  IN_PRODUCTION: 'in_production',
  PARTIALLY_RECEIVED: 'partially_received',
  RECEIVED: 'received',
  CLOSED: 'closed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

const PURCHASE_TRANSITIONS = {
  draft: ['approved', 'cancelled'],
  approved: ['sent', 'cancelled'],
  sent: ['accepted', 'rejected', 'cancelled'],
  accepted: ['in_production', 'cancelled'],
  in_production: ['partially_received', 'received', 'cancelled'],
  partially_received: ['received', 'cancelled'],
  received: ['closed'],
  closed: [],
  rejected: [],
  cancelled: [],
}

// =====================================================================
// WarehouseStatus (StockIn)
// =====================================================================
export const WAREHOUSE_STATUS = {
  PENDING: 'pending',
  ARRIVED: 'arrived',
  INSPECTING: 'inspecting',
  ACCEPTED: 'accepted',
  PARTIAL_ACCEPTED: 'partial_accepted',
  STOCKED: 'stocked',
  REJECTED: 'rejected',
}

const WAREHOUSE_TRANSITIONS = {
  pending: ['arrived'],
  arrived: ['inspecting'],
  inspecting: ['accepted', 'partial_accepted', 'rejected'],
  accepted: ['stocked'],
  partial_accepted: ['stocked'],
  stocked: [],
  rejected: [],
}

// =====================================================================
// ShipmentStatus
// =====================================================================
export const SHIPMENT_STATUS = {
  PENDING: 'pending',
  ALLOCATED: 'allocated',
  PICKED: 'picked',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  PARTIAL_DELIVERED: 'partial_delivered',
  CANCELLED: 'cancelled',
}

const SHIPMENT_TRANSITIONS = {
  pending: ['allocated', 'cancelled'],
  allocated: ['picked', 'cancelled'],
  picked: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'partial_delivered'],
  delivered: [],
  partial_delivered: ['delivered'],
  cancelled: [],
}

// =====================================================================
// BillingStatus
// =====================================================================
export const BILLING_STATUS = {
  PENDING: 'pending',
  INVOICED: 'invoiced',
  PARTIAL_PAID: 'partial_paid',
  PAID: 'paid',
  OVERDUE: 'overdue',
  VOIDED: 'voided',
}

const BILLING_TRANSITIONS = {
  pending: ['invoiced', 'voided'],
  invoiced: ['partial_paid', 'paid', 'overdue', 'voided'],
  partial_paid: ['paid', 'overdue'],
  paid: [],
  overdue: ['partial_paid', 'paid'],
  voided: [],
}

// =====================================================================
// 公開 API
// =====================================================================

const MACHINES = {
  order: ORDER_TRANSITIONS,
  purchase: PURCHASE_TRANSITIONS,
  warehouse: WAREHOUSE_TRANSITIONS,
  shipment: SHIPMENT_TRANSITIONS,
  billing: BILLING_TRANSITIONS,
}

/** 遷移可能な次状態の配列を返す */
export function getNextStates(domain, current) {
  const machine = MACHINES[domain]
  if (!machine) throw new Error(`unknown domain: ${domain}`)
  return machine[current] || []
}

/** 遷移が許可されているか（同一値への遷移は常に許可） */
export function canTransition(domain, from, to) {
  if (from === to) return true
  const next = getNextStates(domain, from)
  return next.includes(to)
}

/**
 * 遷移前の事前チェック。NG の時は throw。
 * 保存処理から呼び出し、AuditLog 原子性の writeBatch 発火前に使う。
 */
export function assertTransition(domain, from, to) {
  if (!canTransition(domain, from, to)) {
    throw new Error(`${domain}Status: ${from} → ${to} は不正な遷移`)
  }
}

/** 終端ステータス（以降遷移できない） */
export function isTerminal(domain, state) {
  return getNextStates(domain, state).length === 0
}
