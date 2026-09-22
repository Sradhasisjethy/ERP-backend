const { defineReport } = require('../lib/registry');
const { text, code, money, int, metric } = require('../lib/columns');
const { allocatedAmount, salesDueDate, daysOutstanding } = require('../lib/fragments');

/**
 * Receivables and payables ageing, one row per party.
 *
 * The invoice-level lists (Receivables, Customer Outstanding, Purchase
 * Summary) already age every open document. What they cannot show is the
 * question a credit controller actually asks — "who owes the most, and how old
 * is it?" — without exporting and pivoting. These reports are that pivot,
 * built from the same open-document queries so the per-party total here always
 * equals the sum of that party's rows there.
 *
 * Buckets are measured from the due date, like the invoice-level reports:
 * a sales invoice falls due after the customer's credit period
 * (parties.creditAgeingDays), a purchase invoice on its own due date. "Not
 * due" is money outstanding but still inside its terms.
 */

const bucketColumns = (days, amount) => `
  COALESCE(SUM(${amount}) FILTER (WHERE ${days} <= 0), 0) AS "notDuePaise",
  COALESCE(SUM(${amount}) FILTER (WHERE ${days} BETWEEN 1 AND 30), 0) AS "days1to30Paise",
  COALESCE(SUM(${amount}) FILTER (WHERE ${days} BETWEEN 31 AND 60), 0) AS "days31to60Paise",
  COALESCE(SUM(${amount}) FILTER (WHERE ${days} BETWEEN 61 AND 90), 0) AS "days61to90Paise",
  COALESCE(SUM(${amount}) FILTER (WHERE ${days} > 90), 0) AS "days90PlusPaise",
  COALESCE(SUM(${amount}), 0) AS "outstandingPaise",
  COUNT(*)::int AS "invoiceCount",
  MAX(${days})::int AS "oldestDays"`;

const COLUMNS = (partyLabel) => [
  code('partyCode', `${partyLabel} Code`),
  text('partyName', partyLabel),
  int('invoiceCount', 'Open Invoices'),
  money('notDuePaise', 'Not Due', { total: true }),
  money('days1to30Paise', '1–30 Days', { total: true }),
  money('days31to60Paise', '31–60 Days', { total: true }),
  money('days61to90Paise', '61–90 Days', { total: true }),
  money('days90PlusPaise', '90+ Days', { total: true }),
  money('outstandingPaise', 'Total Outstanding', { total: true }),
  int('oldestDays', 'Oldest (days overdue)'),
];

const SUMMARY = (partyPlural) => [
  metric('partyCount', partyPlural, 'int'),
  metric('outstandingPaise', 'Outstanding'),
  metric('overduePaise', 'Overdue'),
  metric('days90PlusPaise', 'Over 90 Days'),
];

// Every sortable column needs an entry: the runner silently falls back to the
// default sort for a key it does not know, so a missing one reads as a header
// that does nothing when clicked.
const BUCKETS = {
  notDuePaise: '_days_ <= 0',
  days1to30Paise: '_days_ BETWEEN 1 AND 30',
  days31to60Paise: '_days_ BETWEEN 31 AND 60',
  days61to90Paise: '_days_ BETWEEN 61 AND 90',
  days90PlusPaise: '_days_ > 90',
};

const SORT_MAP = {
  partyCode: 'pt."code"',
  partyName: 'pt."name"',
  invoiceCount: 'COUNT(*)',
  outstandingPaise: 'SUM(_amount_)',
  oldestDays: 'MAX(_days_)',
  ...Object.fromEntries(Object.entries(BUCKETS).map(([key, test]) => [key, `COALESCE(SUM(_amount_) FILTER (WHERE ${test}), 0)`])),
};

const sortMapFor = (days, amount) =>
  Object.fromEntries(Object.entries(SORT_MAP).map(([k, v]) => [k, v.replace('_amount_', amount).replace('_days_', days)]));

const summarySelect = `
  COUNT(*)::int AS "partyCount",
  COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise",
  COALESCE(SUM(_s."outstandingPaise" - _s."notDuePaise"), 0) AS "overduePaise",
  COALESCE(SUM(_s."days90PlusPaise"), 0) AS "days90PlusPaise"`;

defineReport({
  id: 'receivables-ageing',
  category: 'finance',
  slug: 'receivables-ageing',
  name: 'Receivables Ageing',
  description: 'What each customer owes, split by how long it has been overdue.',
  dateFieldLabel: 'Invoice Date',
  limitations: [
    'Aged from the due date, which is the invoice date plus the customer\'s credit period (creditAgeingDays). '
    + 'A customer with no credit period is due on the invoice date. Money received on account and not allocated '
    + 'to an invoice is not deducted here — it shows on the customer ledger.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId'],
  searchFields: ['Customer Name', 'Customer Code'],
  defaultSort: { by: 'outstandingPaise', dir: 'desc' },
  columns: COLUMNS('Customer'),
  summary: SUMMARY('Customers'),
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('si."customerPartyId"', p.customerId);
    where.token('si."status"', 'POSTED');
    where.search(['pt."name"', 'pt."code"'], p.search);
    where.raw('(si."totalPaise" - pay."paidPaise") > 0');

    const days = daysOutstanding(salesDueDate('si."invoiceDate"', 'pt'));
    const amount = '(si."totalPaise" - pay."paidPaise")';

    return {
      from: `
        sales_invoices si
        JOIN parties pt ON pt.id = si."customerPartyId"
        LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si.id')}) pay ON TRUE`,
      select: `
        pt.id AS "id", pt."code" AS "partyCode", pt."name" AS "partyName",
        ${bucketColumns(days, amount)}`,
      where,
      groupBy: 'pt.id, pt."code", pt."name"',
      tieBreak: 'pt.id',
      sortMap: sortMapFor(days, amount),
      summaryGroupBy: true,
      summarySelect,
    };
  },
});

defineReport({
  id: 'payables-ageing',
  category: 'finance',
  slug: 'payables-ageing',
  name: 'Payables Ageing',
  description: 'What is owed to each vendor, split by how long it has been overdue.',
  dateFieldLabel: 'Invoice Date',
  limitations: [
    'Aged from each purchase invoice\'s due date (the invoice date when none was entered). Advances paid and not '
    + 'allocated to an invoice are not deducted here — they show on the vendor ledger.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId'],
  searchFields: ['Vendor Name', 'Vendor Code'],
  defaultSort: { by: 'outstandingPaise', dir: 'desc' },
  columns: COLUMNS('Vendor'),
  summary: SUMMARY('Vendors'),
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pi."tenantId"');
    where.raw(`pi."status" = 'POSTED'`);
    where.factoryScope('pi."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('pi."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('pi."vendorPartyId"', p.vendorId);
    where.search(['pt."name"', 'pt."code"'], p.search);
    where.raw('(pi."amountPaise" - pay."paidPaise") > 0');

    const days = daysOutstanding('COALESCE(pi."dueDate", pi."invoiceDate")');
    const amount = '(pi."amountPaise" - pay."paidPaise")';

    return {
      from: `
        purchase_invoices pi
        JOIN parties pt ON pt.id = pi."vendorPartyId"
        LEFT JOIN LATERAL (${allocatedAmount('PURCHASE', 'pi.id')}) pay ON TRUE`,
      select: `
        pt.id AS "id", pt."code" AS "partyCode", pt."name" AS "partyName",
        ${bucketColumns(days, amount)}`,
      where,
      groupBy: 'pt.id, pt."code", pt."name"',
      tieBreak: 'pt.id',
      sortMap: sortMapFor(days, amount),
      summaryGroupBy: true,
      summarySelect,
    };
  },
});
