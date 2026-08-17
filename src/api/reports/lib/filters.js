/**
 * Filter descriptors served to the client.
 *
 * The UI does not decide what a filter means or which values it accepts — it
 * renders what this publishes. That is what stops a "Status" dropdown offering
 * POSTED on a report whose status column is a party's active/inactive flag,
 * and it means adding a filter to a report needs no frontend change at all.
 *
 * `control` tells the client what to render:
 *   date     a date input
 *   entity   a picker fed from `source` (an existing list endpoint)
 *   select   a fixed vocabulary, in `options`
 *   text     free text
 *   toggle   a checkbox
 */

const option = (value, label) => ({ value, label });

/** Vocabularies shared by several reports. */
const VOCABULARY = Object.freeze({
  documentStatus: [option('POSTED', 'Posted'), option('CANCELLED', 'Cancelled')],
  partyStatus: [option('active', 'Active'), option('inactive', 'Inactive')],
  salesOrderStatus: [
    option('DRAFT', 'Draft'),
    option('CONFIRMED', 'Confirmed'),
    option('IN_PRODUCTION', 'In Production'),
    option('PARTIALLY_DISPATCHED', 'Partially Dispatched'),
    option('DISPATCHED', 'Dispatched'),
    option('SHORT_CLOSED', 'Short Closed'),
    option('CANCELLED', 'Cancelled'),
  ],
  transferStatus: [option('IN_TRANSIT', 'In Transit'), option('RECEIVED', 'Received'), option('CANCELLED', 'Cancelled')],
  paymentStatus: [option('UNPAID', 'Unpaid'), option('PARTIALLY_PAID', 'Partially Paid'), option('PAID', 'Paid')],
  productType: [option('FINISHED_GOOD', 'Finished Good'), option('RAW_MATERIAL', 'Raw Material')],
  stockStatus: [
    option('IN_STOCK', 'In Stock'),
    option('BELOW_REORDER', 'Below Reorder Level'),
    option('OUT_OF_STOCK', 'Out of Stock'),
    option('EXCESS', 'Above Maximum'),
  ],
  ageingClass: [option('FRESH', 'Fresh'), option('SLOW_MOVING', 'Slow Moving'), option('DEAD', 'Dead')],
  attendanceStatus: [
    option('PRESENT', 'Present'),
    option('HALF_DAY', 'Half Day'),
    option('ABSENT', 'Absent'),
    option('OVERTIME', 'Overtime'),
  ],
  paymentMode: [option('CASH', 'Cash'), option('UPI', 'UPI'), option('BANK', 'Bank Transfer'), option('CHEQUE', 'Cheque')],
  cashMode: [option('CASH', 'Cash'), option('BANK', 'Bank')],
  moneyDirection: [option('RECEIPT', 'Money In (Receipt)'), option('PAYMENT', 'Money Out (Payment)')],
  liquidAccount: [option('CASH', 'Cash'), option('BANK', 'Bank')],
  movementType: [
    option('PRODUCTION_IN', 'Production In'),
    option('PRODUCTION_OUT', 'Production Out'),
    option('PURCHASE_IN', 'Purchase In'),
    option('SALE_OUT', 'Sale Out'),
    option('TRANSFER_IN', 'Transfer In'),
    option('TRANSFER_OUT', 'Transfer Out'),
    option('RETURN_IN', 'Return In'),
    option('RETURN_OUT', 'Return Out'),
    option('ADJUSTMENT_IN', 'Adjustment In'),
    option('ADJUSTMENT_OUT', 'Adjustment Out'),
    option('BREAKAGE_OUT', 'Breakage'),
    option('CONTRACTOR_ISSUE_OUT', 'Issued to Contractor'),
    option('CONTRACTOR_ISSUE_IN', 'Returned by Contractor'),
    option('REVERSAL', 'Reversal'),
  ],
  adjustmentType: [
    option('ADJUSTMENT_IN', 'Adjustment In'),
    option('ADJUSTMENT_OUT', 'Adjustment Out'),
    option('BREAKAGE_OUT', 'Breakage'),
  ],
});

/** How each filter presents by default. A report may override any of it. */
const DEFAULTS = Object.freeze({
  dateFrom: { label: 'Date From', control: 'date' },
  dateTo: { label: 'Date To', control: 'date' },
  factoryId: { label: 'Location', control: 'entity', source: 'factories' },
  customerId: { label: 'Customer', control: 'entity', source: 'parties', partyType: 'CUSTOMER' },
  vendorId: { label: 'Vendor', control: 'entity', source: 'parties', partyType: 'VENDOR' },
  contractorId: { label: 'Contractor', control: 'entity', source: 'parties', partyType: 'CONTRACTOR' },
  labourId: { label: 'Labour', control: 'entity', source: 'parties', partyType: 'LABOUR' },
  partyId: { label: 'Party', control: 'entity', source: 'parties' },
  productId: { label: 'Product', control: 'entity', source: 'products' },
  categoryId: { label: 'Product Category', control: 'entity', source: 'product-categories' },
  status: { label: 'Status', control: 'select', options: VOCABULARY.documentStatus },
  paymentStatus: { label: 'Payment Status', control: 'select', options: VOCABULARY.paymentStatus },
  movementType: { label: 'Movement Type', control: 'select', options: VOCABULARY.movementType },
  referenceType: { label: 'Reference Type', control: 'text' },
  productType: { label: 'Product Type', control: 'select', options: VOCABULARY.productType },
  stockStatus: { label: 'Stock Status', control: 'select', options: VOCABULARY.stockStatus },
  ageingClass: { label: 'Age Bucket', control: 'select', options: VOCABULARY.ageingClass },
  attendanceStatus: { label: 'Attendance', control: 'select', options: VOCABULARY.attendanceStatus },
  expenseCategory: { label: 'Expense Category', control: 'text' },
  paymentMode: { label: 'Payment Mode', control: 'select', options: VOCABULARY.paymentMode },
  direction: { label: 'Direction', control: 'select', options: VOCABULARY.moneyDirection },
  accountKey: { label: 'Account', control: 'select', options: VOCABULARY.liquidAccount },
  overdueOnly: { label: 'Overdue only', control: 'toggle' },
});

/**
 * Filters worth keeping on screen at all times. Everything else folds into
 * "More filters", so the common case is one row of controls rather than nine
 * (§13).
 */
const PRIMARY = new Set(['dateFrom', 'dateTo', 'factoryId', 'customerId', 'vendorId', 'contractorId', 'labourId', 'partyId', 'status']);

/** Resolves a report's declared filter keys into full descriptors. */
const describeFilters = (definition) =>
  (definition.filters || []).map((key) => {
    const base = DEFAULTS[key];
    if (!base) throw new Error(`Report "${definition.id}" declares filter "${key}" with no descriptor`);
    const override = (definition.filterOptions || {})[key] || {};
    return {
      key,
      ...base,
      ...override,
      primary: 'primary' in override ? override.primary : PRIMARY.has(key),
    };
  });

module.exports = { VOCABULARY, DEFAULTS, describeFilters };
