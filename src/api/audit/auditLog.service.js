const { Op } = require('sequelize');
const { AuditLog } = require('./auditLog.model');
const { User } = require('../users/user.model');
const { hasPermission } = require('../../middlewares/authorize');
const { maskRateFields } = require('../../utils/fieldMasking');

/**
 * What a caller must hold to read the audit rows of each entity type.
 *
 * AUDIT_READ alone used to return every row, so an accountant could read
 * employees' home addresses and every login's IP off the audit screen while the
 * employee screen itself refused them. An audit row is a copy of the record, so
 * it is gated by the permission that reads the record. Several codes = all of
 * them (an allocation sits between a receipt and a payment).
 *
 * Keys are every `entityType` actually written: BaseAuditedModel subclasses
 * (ModelRef.name) plus the hand-written rows — Session (auth.controller LOGIN)
 * and CounterSaleAccessory (counterSale.service).
 */
const ENTITY_READ_PERMISSIONS = {
  User: ['EMPLOYEE_READ'],
  Session: ['EMPLOYEE_READ'],
  AdGroup: ['ROLE_READ'],
  AdGroupMember: ['ROLE_READ'],
  Organization: ['ORG_READ'],
  Office: ['ORG_READ'],
  Department: ['ORG_READ'],
  OfficeDepartment: ['ORG_READ'],
  Factory: ['FACTORY_READ'],
  Party: ['PARTY_READ'],
  PartyAddress: ['PARTY_READ'],
  LabourWageProfile: ['LABOUR_READ'],
  Product: ['PRODUCT_READ'],
  ProductCategory: ['PRODUCT_READ'],
  Uom: ['PRODUCT_READ'],
  UomConversion: ['PRODUCT_READ'],
  HsnCode: ['PRODUCT_READ'],
  MixDesign: ['PRODUCT_READ'],
  MixDesignLine: ['PRODUCT_READ'],
  BundleRule: ['PRODUCT_READ'],
  BundleComponent: ['PRODUCT_READ'],
  BundleComponentSuppression: ['SALES_READ'],
  Vehicle: ['VEHICLE_READ'],
  PriceList: ['PRICING_READ'],
  PriceListItem: ['PRICING_READ'],
  Lead: ['LEAD_READ'],
  LeadActivity: ['LEAD_READ'],
  Quotation: ['QUOTATION_READ'],
  SalesOrder: ['SALES_READ'],
  SalesOrderLine: ['SALES_READ'],
  DeliveryChallan: ['DISPATCH_READ'],
  DeliveryChallanLine: ['DISPATCH_READ'],
  SalesInvoice: ['INVOICE_READ'],
  SalesInvoiceLine: ['INVOICE_READ'],
  CounterSaleAccessory: ['INVOICE_READ'],
  SalesReturn: ['RETURN_READ'],
  SalesReturnLine: ['RETURN_READ'],
  PurchaseReturn: ['RETURN_READ'],
  PurchaseReturnLine: ['RETURN_READ'],
  CreditNote: ['RETURN_READ'],
  DebitNote: ['RETURN_READ'],
  PurchaseIndent: ['PURCHASE_READ'],
  PurchaseIndentLine: ['PURCHASE_READ'],
  PurchaseOrder: ['PURCHASE_READ'],
  PurchaseOrderLine: ['PURCHASE_READ'],
  GoodsReceipt: ['PURCHASE_READ'],
  GoodsReceiptLine: ['PURCHASE_READ'],
  PurchaseInvoice: ['PURCHASE_READ'],
  ProductionPlan: ['PRODUCTION_READ'],
  ProductionPlanLine: ['PRODUCTION_READ'],
  ProductionEntry: ['PRODUCTION_READ'],
  MaterialConsumption: ['PRODUCTION_READ'],
  WastageRecord: ['WASTAGE_READ'],
  QualityInspection: ['QUALITY_READ'],
  StockLot: ['INVENTORY_READ'],
  StockReservation: ['INVENTORY_READ'],
  StockAdjustment: ['INVENTORY_READ'],
  StockTransfer: ['TRANSFER_READ'],
  StockTransferLine: ['TRANSFER_READ'],
  ContractorMaterialIssue: ['CONTRACTOR_READ'],
  ContractorMaterialIssueLine: ['CONTRACTOR_READ'],
  ContractorProductionEntry: ['CONTRACTOR_READ'],
  AttendanceRecord: ['LABOUR_READ'],
  Advance: ['LABOUR_READ'],
  LeaveType: ['LEAVE_READ'],
  LeaveRequest: ['LEAVE_READ'],
  StaffAttendance: ['STAFF_ATTENDANCE_READ'],
  Receipt: ['RECEIPT_READ'],
  Payment: ['PAYMENT_READ'],
  Cheque: ['PAYMENT_READ'],
  PaymentAllocation: ['RECEIPT_READ', 'PAYMENT_READ'],
  Expense: ['EXPENSE_READ'],
  CashRegisterSession: ['CASH_REGISTER_READ'],
  JournalVoucher: ['JOURNAL_READ'],
  FixedAsset: ['FIXED_ASSET_READ'],
  DepreciationRun: ['FIXED_ASSET_READ'],
  SavedReport: ['REPORT_READ'],
};

/**
 * An entity type nobody has mapped yet. Admin-level rather than open: a new
 * audited model is invisible to the audit screen until someone decides who may
 * read it, which fails closed instead of leaking.
 */
const UNMAPPED_ENTITY_PERMISSION = 'SETTINGS_MODIFY';

// Personal details on a User snapshot — HR-editable data, not audit trivia.
const USER_PERSONAL_FIELDS = [
  'phone', 'address', 'city', 'state', 'country', 'pincode', 'gender', 'dateOfJoining', 'resignationDate',
];
const REDACTED = '[redacted]';

// hasOwn, not a plain lookup: `?entityType=constructor` must not find Object's.
const canRead = (user, entityType) =>
  (Object.hasOwn(ENTITY_READ_PERMISSIONS, entityType) ? ENTITY_READ_PERMISSIONS[entityType] : [UNMAPPED_ENTITY_PERMISSION])
    .every((code) => hasPermission(user, code));

/**
 * The entityType clause for what `user` may read, or null for "everything".
 * Built into the query, not filtered afterwards, so `count` and page sizes stay
 * true.
 */
const readableEntityWhere = (user) => {
  const known = Object.keys(ENTITY_READ_PERMISSIONS);
  const allowed = known.filter((type) => canRead(user, type));
  const unmapped = hasPermission(user, UNMAPPED_ENTITY_PERMISSION);

  if (unmapped && allowed.length === known.length) return null;
  if (!unmapped) return { entityType: { [Op.in]: allowed } };
  return { [Op.or]: [{ entityType: { [Op.in]: allowed } }, { entityType: { [Op.notIn]: known } }] };
};

const redactSnapshot = (snapshot, fields) => {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const clone = { ...snapshot };
  // Replaced rather than deleted: that the field changed is still audit
  // evidence; only its value is withheld.
  for (const field of fields) {
    if (clone[field] !== undefined && clone[field] !== null) clone[field] = REDACTED;
  }
  return clone;
};

class AuditLogService {
  static async list(page, limit, { entityType, entityId, userId } = {}, viewer = null) {
    const offset = (page - 1) * limit;
    const where = {};
    if (entityId) where.entityId = entityId;
    if (userId) where.userId = userId;

    if (entityType) {
      // A type the caller cannot read is simply empty — not a 403, which would
      // confirm what exists.
      if (!canRead(viewer, entityType)) return { rows: [], count: 0 };
      where.entityType = entityType;
    } else {
      Object.assign(where, readableEntityWhere(viewer) || {});
    }

    return AuditLog.findAndCountAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'email'], required: false }],
    });
  }

  /**
   * Withholds what the caller's other grants would not show them: personal
   * details on employee snapshots, the network trail of every action, actor
   * emails and money. Bypass roles hold every code, so they see it all.
   */
  static redactRow(row, req) {
    const user = req.user;
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };

    if (plain.entityType === 'User' && !hasPermission(user, 'EMPLOYEE_MODIFY')) {
      plain.beforeSnapshot = redactSnapshot(plain.beforeSnapshot, USER_PERSONAL_FIELDS);
      plain.afterSnapshot = redactSnapshot(plain.afterSnapshot, USER_PERSONAL_FIELDS);
    }

    // Where someone signed in from is security data, for whoever manages
    // accounts or the system — not for every auditor.
    if (!hasPermission(user, 'EMPLOYEE_MODIFY') && !hasPermission(user, 'SETTINGS_MODIFY')) {
      plain.ipAddress = null;
      for (const key of ['beforeSnapshot', 'afterSnapshot']) {
        if (plain[key] && typeof plain[key] === 'object' && 'userAgent' in plain[key]) {
          plain[key] = { ...plain[key], userAgent: null };
        }
      }
    }

    if (plain.User && !hasPermission(user, 'EMPLOYEE_READ')) plain.User = { ...plain.User, email: null };

    return maskRateFields(plain, req);
  }
}

module.exports = { AuditLogService, ENTITY_READ_PERMISSIONS, UNMAPPED_ENTITY_PERMISSION };
