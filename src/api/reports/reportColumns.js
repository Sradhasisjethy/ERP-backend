/**
 * Column definitions for exportable reports (FR-M27-2).
 *
 * `money: true` marks a column that must disappear entirely from an export for
 * a user without VIEW_RATES (FR-M27-3) — see utils/exporter.js#buildColumns.
 * Any column whose key ends in "Paise" is treated as money automatically, so
 * the flag is only needed for money columns named otherwise.
 */
const REPORT_COLUMNS = {
  STOCK_AGEING: {
    title: 'Stock Ageing',
    columns: [
      { key: 'lotNumber', header: 'Lot #' },
      { key: 'productName', header: 'Product' },
      { key: 'originDate', header: 'Origin Date' },
      { key: 'ageDays', header: 'Age (days)' },
      { key: 'bucket', header: 'Bucket' },
      { key: 'qtyAvailable', header: 'Quantity' },
      { key: 'valuePaise', header: 'Value' },
    ],
  },
  COSTING: {
    title: 'Product Costing',
    columns: [
      { key: 'productName', header: 'Product' },
      { key: 'mixDesignName', header: 'Mix Design' },
      { key: 'standardCostPaise', header: 'Standard Cost' },
      { key: 'avgSellingRatePaise', header: 'Avg Selling Rate' },
      { key: 'marginPaise', header: 'Margin' },
      { key: 'marginPercent', header: 'Margin %', money: true },
    ],
  },
  ALERTS: {
    title: 'Alerts',
    columns: [
      { key: 'type', header: 'Type' },
      { key: 'severity', header: 'Severity' },
      { key: 'message', header: 'Alert' },
      { key: 'date', header: 'Date' },
      { key: 'outstandingPaise', header: 'Outstanding' },
    ],
  },
  TRIAL_BALANCE: {
    title: 'Trial Balance',
    columns: [
      { key: 'code', header: 'Code' },
      { key: 'name', header: 'Account' },
      { key: 'type', header: 'Type' },
      { key: 'totalDebitPaise', header: 'Debit' },
      { key: 'totalCreditPaise', header: 'Credit' },
      { key: 'balancePaise', header: 'Balance' },
    ],
  },
  CASH_BOOK: {
    title: 'Cash Book',
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'narration', header: 'Narration' },
      { key: 'referenceType', header: 'Reference' },
      { key: 'debitPaise', header: 'Debit' },
      { key: 'creditPaise', header: 'Credit' },
      { key: 'runningBalancePaise', header: 'Running Balance' },
    ],
  },
  PARTY_LEDGER: {
    title: 'Party Ledger',
    columns: [
      { key: 'date', header: 'Date' },
      { key: 'accountName', header: 'Account' },
      { key: 'narration', header: 'Narration' },
      { key: 'debitPaise', header: 'Debit' },
      { key: 'creditPaise', header: 'Credit' },
    ],
  },
  DOCUMENT_SEARCH: {
    title: 'Document Search',
    columns: [
      { key: 'documentType', header: 'Document Type' },
      { key: 'number', header: 'Number' },
      { key: 'date', header: 'Date' },
    ],
  },
  CANCELLATION_ANALYTICS: {
    title: 'Cancellation Analytics',
    columns: [
      { key: 'documentType', header: 'Document Type' },
      { key: 'reason', header: 'Reason' },
      { key: 'count', header: 'Count' },
      { key: 'totalValuePaise', header: 'Value' },
    ],
  },
  GSTR1: {
    title: 'GSTR-1 (B2B + B2C)',
    columns: [
      { key: 'section', header: 'Section' },
      { key: 'invoiceNumber', header: 'Invoice #' },
      { key: 'invoiceDate', header: 'Date' },
      { key: 'customerName', header: 'Customer' },
      { key: 'customerGstin', header: 'GSTIN' },
      { key: 'placeOfSupply', header: 'Place of Supply' },
      { key: 'taxableValuePaise', header: 'Taxable Value' },
      { key: 'cgstPaise', header: 'CGST' },
      { key: 'sgstPaise', header: 'SGST' },
      { key: 'igstPaise', header: 'IGST' },
      { key: 'totalPaise', header: 'Total' },
    ],
  },
};

/**
 * Reports return different shapes — a bare array, `{ rows }`, or a nested
 * structure. This flattens each into the single row list an export needs,
 * keeping that knowledge here rather than in the export handler.
 */
const flattenForExport = (reportType, data) => {
  switch (reportType) {
    case 'STOCK_AGEING':
      return data.lots || [];
    case 'PARTY_LEDGER':
      return (data.rows || []).map((r) => ({
        date: r.journalEntry?.entryDate,
        accountName: r.account?.name,
        narration: r.journalEntry?.narration,
        debitPaise: r.debitPaise,
        creditPaise: r.creditPaise,
      }));
    case 'CANCELLATION_ANALYTICS':
      return (data.byDocumentType || []).flatMap((doc) =>
        (doc.topReasons || []).map((r) => ({
          documentType: doc.documentType,
          reason: r.reason,
          count: r.count,
          totalValuePaise: doc.totalValuePaise,
        }))
      );
    case 'GSTR1':
      return [
        ...(data.b2b || []).map((r) => ({ ...r, section: 'B2B' })),
        ...(data.b2c || []).map((r) => ({ ...r, section: 'B2C' })),
      ];
    default:
      return Array.isArray(data) ? data : data.rows || [];
  }
};

module.exports = { REPORT_COLUMNS, flattenForExport };
