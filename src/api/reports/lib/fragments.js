/**
 * SQL fragments shared by several reports.
 *
 * These exist so a figure means the same thing everywhere it appears. "Paid
 * against this invoice" in the Sales Summary, the Customer Outstanding report
 * and the Receivables report is one definition, matching what
 * payments.service.js#getInvoiceAllocatedAmount enforces at write time — not
 * three hand-written subqueries that quietly disagree about whether a
 * cancelled receipt still counts.
 */

/**
 * Amount allocated against an invoice by POSTED receipts and payments.
 * Mirrors payments.service.js#getInvoiceAllocatedAmount exactly, including its
 * treatment of allocations that hang off either a receipt or a payment.
 *
 * @param {'SALES'|'PURCHASE'} invoiceType
 * @param {string} invoiceRef  SQL expression for the invoice id (e.g. `si.id`)
 */
const allocatedAmount = (invoiceType, invoiceRef) => `
  SELECT COALESCE(SUM(pa."allocatedAmountPaise"), 0) AS "paidPaise"
  FROM payment_allocations pa
  LEFT JOIN receipts r ON r.id = pa."receiptId" AND r.status = 'POSTED'
  LEFT JOIN payments pm ON pm.id = pa."paymentId" AND pm.status = 'POSTED'
  WHERE pa."invoiceType" = '${invoiceType}'
    AND pa."invoiceId" = ${invoiceRef}
    AND (r.id IS NOT NULL OR pm.id IS NOT NULL)
`;

/** UNPAID / PARTIALLY_PAID / PAID from a total and what has been allocated. */
const paymentStatusExpr = (totalRef, paidRef) => `
  CASE
    WHEN ${paidRef} <= 0 THEN 'UNPAID'
    WHEN ${paidRef} >= ${totalRef} THEN 'PAID'
    ELSE 'PARTIALLY_PAID'
  END
`;

/**
 * Due date for a sales invoice.
 *
 * SalesInvoice has no dueDate column — unlike PurchaseInvoice, which does. The
 * credit period is a property of the customer (`parties.creditAgeingDays`), so
 * the due date is derived from the configured term rather than invented. A
 * customer with no term configured is treated as due on the invoice date,
 * which is what "no credit extended" means.
 */
const salesDueDate = (invoiceDateRef, partyAlias) =>
  `(${invoiceDateRef}::date + COALESCE(${partyAlias}."creditAgeingDays", 0) * INTERVAL '1 day')::date`;

/** Whole days a still-open document has been outstanding, as at today. */
const daysOutstanding = (dueDateExpr) => `GREATEST(0, (CURRENT_DATE - ${dueDateExpr})::int)`;

/**
 * Standard receivables/payables ageing buckets. Fixed banding is the
 * convention finance teams read these in; unlike stock ageing (which follows a
 * per-product configured policy) there is no configurable AR ageing policy in
 * this schema to honour.
 */
const ageingBucket = (daysExpr) => `
  CASE
    WHEN ${daysExpr} <= 0 THEN 'Not due'
    WHEN ${daysExpr} <= 30 THEN '1-30 days'
    WHEN ${daysExpr} <= 60 THEN '31-60 days'
    WHEN ${daysExpr} <= 90 THEN '61-90 days'
    ELSE '90+ days'
  END
`;

/**
 * Net running balance for a party across the books, in paise (debit - credit).
 * Positive means they owe us (customers) or we have over-paid (vendors); the
 * sign convention is the same either way because a party only ever posts
 * against its own control account — see ledger.service.js#getPartyOutstanding.
 */
const partyBalance = (partyRef) => `
  SELECT COALESCE(SUM(jl."debitPaise"), 0) - COALESCE(SUM(jl."creditPaise"), 0) AS "balancePaise"
  FROM journal_lines jl
  WHERE jl."partyId" = ${partyRef}
`;

/**
 * Sums one payment mode out of the `modes` JSONB array carried by receipts and
 * payments. Only CASH/UPI/BANK/CHEQUE exist (payments.schema.js), so the
 * report shows those four and nothing invented.
 */
const modeAmount = (modesRef, mode) => `
  COALESCE((
    SELECT SUM((m->>'amountPaise')::bigint)
    FROM jsonb_array_elements(${modesRef}) m
    WHERE m->>'mode' = '${mode}'
  ), 0)
`;

/** The payment modes actually used on a document, as a readable list. */
const modeList = (modesRef) => `
  COALESCE((
    SELECT string_agg(DISTINCT m->>'mode', ', ' ORDER BY m->>'mode')
    FROM jsonb_array_elements(${modesRef}) m
  ), '')
`;

const PAYMENT_MODES = Object.freeze(['CASH', 'UPI', 'BANK', 'CHEQUE']);

/** Value of stock on hand, at standard cost — the only cost this schema holds. */
const lotValue = (qtyRef, productAlias) => `ROUND(${qtyRef} * COALESCE(${productAlias}."standardCostPaise", 0))`;

module.exports = {
  allocatedAmount,
  paymentStatusExpr,
  salesDueDate,
  daysOutstanding,
  ageingBucket,
  partyBalance,
  modeAmount,
  modeList,
  lotValue,
  PAYMENT_MODES,
};
