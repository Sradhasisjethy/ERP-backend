/**
 * Default roles for a manufacturing plant.
 *
 * Why this file exists: the seeded roles were HR-shaped (HR Manager,
 * Engineering Lead, Employee, Guest) and not one of them held a single
 * operational permission. Every production, inventory, sales, purchase,
 * dispatch, quality and vehicle screen was therefore reachable only by
 * Platform Admin and Tenant Owner — the two roles that bypass permission
 * checks entirely — so in practice the ERP had one usable role: superuser.
 *
 * Two rules shape the grants below.
 *
 * 1. **VIEW_RATES is not a shop-floor permission.** It unmasks money —
 *    dashboard financial widgets, price-list rates, product standard cost and
 *    every `money` column in every report. BR-07 and pain-point P7 exist
 *    because rates used to leak to the floor, so the production, quality and
 *    stores roles deliberately do not hold it. Note it gates *reading* money,
 *    not writing it: a storekeeper can still key the rate off a supplier's
 *    invoice when booking a goods receipt.
 *
 * 2. **Approval is separate from doing.** Raising a purchase indent and
 *    approving one are different grants (FR-M11-1), as are recording a
 *    material variance and signing it off (BR-09). Roles that do the work do
 *    not automatically get to approve their own.
 *
 * These are a starting point, not a straitjacket — every one is editable in
 * Administration > Roles & Permissions, and a plant that splits duties
 * differently should.
 */

/** Read access to every report category, without the export grants. */
const ALL_REPORT_READS = [
  'REPORT_READ',
  'REPORT_SALES_READ',
  'REPORT_ORDER_READ',
  'REPORT_PURCHASE_READ',
  'REPORT_PRODUCTION_READ',
  'REPORT_INVENTORY_READ',
  'REPORT_CUSTOMER_READ',
  'REPORT_VENDOR_READ',
  'REPORT_CONTRACTOR_READ',
  'REPORT_LABOUR_READ',
  'REPORT_FINANCE_READ',
  'REPORT_ANALYTICS_READ',
];

const DEFAULT_ROLES = [
  {
    name: 'Platform Admin',
    description: 'Full system access',
    permissions: ['*'],
  },

  {
    name: 'Plant Manager',
    description: 'Runs the site: sees everything operational, approves variances and overrides',
    permissions: [
      'PRODUCTION_READ', 'PRODUCTION_CREATE', 'PRODUCTION_MODIFY', 'PRODUCTION_DELETE', 'PRODUCTION_APPROVE_VARIANCE',
      'QUALITY_READ', 'QUALITY_CREATE', 'QUALITY_MODIFY',
      'WASTAGE_READ', 'WASTAGE_CREATE', 'WASTAGE_MODIFY',
      'INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_MODIFY',
      'TRANSFER_READ', 'TRANSFER_CREATE', 'TRANSFER_MODIFY',
      'PURCHASE_READ', 'PURCHASE_APPROVE',
      'SALES_READ', 'DISPATCH_READ', 'INVOICE_READ', 'RETURN_READ',
      'PARTY_READ', 'PRODUCT_READ', 'PRICING_READ', 'VEHICLE_READ',
      'FACTORY_READ', 'ORG_READ', 'EMPLOYEE_READ',
      // The two documented overrides: releasing a lot before its curing period
      // ends, and consuming a specific lot out of FIFO order. Both demand a
      // reason and both are recorded permanently against the lot.
      'OVERRIDE_CURING', 'OVERRIDE_LOT_SELECTION',
      'ANALYTICS_READ', 'AUDIT_READ', 'VIEW_RATES',
      ...ALL_REPORT_READS,
    ],
  },

  {
    name: 'Production Supervisor',
    description: 'Records casting runs and wastage, signs off material variances',
    permissions: [
      'PRODUCTION_READ', 'PRODUCTION_CREATE', 'PRODUCTION_MODIFY', 'PRODUCTION_DELETE', 'PRODUCTION_APPROVE_VARIANCE',
      'WASTAGE_READ', 'WASTAGE_CREATE', 'WASTAGE_MODIFY',
      // Sees which lots are held for testing, but does not sign the tests off.
      'QUALITY_READ',
      'INVENTORY_READ', 'PRODUCT_READ', 'FACTORY_READ',
      'REPORT_PRODUCTION_READ', 'REPORT_INVENTORY_READ',
      // No VIEW_RATES — see the note at the top of this file.
    ],
  },

  {
    name: 'Quality Inspector',
    description: 'Raises inspections and records the verdict that releases or quarantines a lot',
    permissions: [
      'QUALITY_READ', 'QUALITY_CREATE', 'QUALITY_MODIFY', 'QUALITY_DELETE',
      'INVENTORY_READ', 'PRODUCTION_READ', 'PRODUCT_READ', 'FACTORY_READ',
      'WASTAGE_READ', 'WASTAGE_CREATE',
      'REPORT_PRODUCTION_READ', 'REPORT_INVENTORY_READ',
    ],
  },

  {
    name: 'Store Keeper',
    description: 'Receives material, moves and counts stock, keeps the fleet list',
    permissions: [
      'INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_MODIFY',
      'TRANSFER_READ', 'TRANSFER_CREATE', 'TRANSFER_MODIFY',
      // Goods receipts live under purchasing, so booking a delivery in needs
      // PURCHASE_CREATE. Deliberately without PURCHASE_APPROVE.
      'PURCHASE_READ', 'PURCHASE_CREATE',
      'WASTAGE_READ', 'WASTAGE_CREATE',
      'QUALITY_READ',
      'VEHICLE_READ', 'VEHICLE_CREATE', 'VEHICLE_MODIFY',
      'PRODUCT_READ', 'PARTY_READ', 'FACTORY_READ',
      'REPORT_INVENTORY_READ', 'REPORT_PURCHASE_READ',
    ],
  },

  {
    name: 'Purchase Officer',
    description: 'Raises indents and purchase orders, manages vendors',
    permissions: [
      'PURCHASE_READ', 'PURCHASE_CREATE', 'PURCHASE_MODIFY', 'PURCHASE_APPROVE',
      'PARTY_READ', 'PARTY_CREATE', 'PARTY_MODIFY',
      'PRODUCT_READ', 'INVENTORY_READ', 'VEHICLE_READ', 'FACTORY_READ',
      'RETURN_READ', 'RETURN_CREATE',
      'VIEW_PO_ATTACHMENTS', 'VIEW_RATES',
      'REPORT_PURCHASE_READ', 'REPORT_VENDOR_READ', 'REPORT_INVENTORY_READ',
    ],
  },

  {
    name: 'Sales Executive',
    description: 'Takes orders, arranges dispatch, manages customers',
    permissions: [
      'SALES_READ', 'SALES_CREATE', 'SALES_MODIFY',
      'DISPATCH_READ', 'DISPATCH_CREATE', 'DISPATCH_MODIFY',
      'RETURN_READ', 'RETURN_CREATE',
      'INVOICE_READ',
      'PARTY_READ', 'PARTY_CREATE', 'PARTY_MODIFY',
      'PRICING_READ', 'PRODUCT_READ', 'INVENTORY_READ', 'VEHICLE_READ', 'FACTORY_READ',
      'VIEW_RATES',
      // Deliberately without SALES_CREDIT_OVERRIDE: exceeding a customer's
      // credit limit (BR-13) is a decision for whoever carries the debt.
      'REPORT_SALES_READ', 'REPORT_ORDER_READ', 'REPORT_CUSTOMER_READ',
    ],
  },

  {
    name: 'Accountant',
    description: 'Invoicing, receipts, payments, expenses and the books',
    permissions: [
      'INVOICE_READ', 'INVOICE_CREATE', 'INVOICE_MODIFY',
      'RECEIPT_READ', 'RECEIPT_CREATE', 'RECEIPT_MODIFY',
      'PAYMENT_READ', 'PAYMENT_CREATE', 'PAYMENT_MODIFY',
      'EXPENSE_READ', 'EXPENSE_CREATE', 'EXPENSE_MODIFY',
      'FINANCE_ADJUSTMENT_READ', 'FINANCE_ADJUSTMENT_CREATE', 'FINANCE_ADJUSTMENT_MODIFY',
      'RETURN_READ',
      'LEDGER_READ', 'GSTR_READ',
      'PARTY_READ', 'PRODUCT_READ', 'PRICING_READ', 'FACTORY_READ',
      'SALES_READ', 'PURCHASE_READ',
      'VIEW_RATES', 'AUDIT_READ',
      'REPORT_READ', 'REPORT_FINANCE_READ', 'REPORT_FINANCE_EXPORT',
      'REPORT_SALES_READ', 'REPORT_PURCHASE_READ', 'REPORT_CUSTOMER_READ', 'REPORT_VENDOR_READ',
    ],
  },

  {
    name: 'HR Manager',
    description: 'HR capabilities',
    // Can onboard and edit people but not delete them — the kind of split the
    // coarse EMPLOYEE_WRITE this used to hold couldn't express.
    permissions: ['EMPLOYEE_READ', 'EMPLOYEE_CREATE', 'EMPLOYEE_MODIFY', 'ORG_READ', 'SETTINGS_READ'],
  },

  {
    name: 'Employee',
    description: 'Standard access',
    permissions: ['EMPLOYEE_READ'],
  },

  {
    name: 'Guest',
    description: 'Limited access',
    permissions: [],
  },
];

module.exports = { DEFAULT_ROLES, ALL_REPORT_READS };
