const { defineReport } = require('../lib/registry');
const { VOCABULARY } = require('../lib/filters');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');
const { allocatedAmount, paymentStatusExpr, salesDueDate, daysOutstanding, ageingBucket } = require('../lib/fragments');

/**
 * Customer, vendor, contractor and labour reports.
 *
 * Three shapes recur across all four party types, so each is written once and
 * registered under the categories that need it:
 *
 *   - a party ledger (the statement), which is journal_lines for that party
 *     with a running balance;
 *   - a party summary (activity + balance);
 *   - an outstanding list (open documents, aged).
 *
 * Sign convention follows the books. Customers post against ACCOUNTS_RECEIVABLE
 * (invoice debits, receipt credits), so what they owe is debit − credit.
 * Vendors, contractors and labour post against ACCOUNTS_PAYABLE (the liability
 * credits when they earn, debits when they are paid), so what we owe them is
 * credit − debit. Reporting both as a bare debit−credit would show every
 * payable as a negative number, which is not how anyone reads a statement.
 */

const RECEIVABLE = { sign: 'debit', balance: '(jl."debitPaise" - jl."creditPaise")' };
const PAYABLE = { sign: 'credit', balance: '(jl."creditPaise" - jl."debitPaise")' };

// ---------------------------------------------------------------------------
// Party ledger (statement)
// ---------------------------------------------------------------------------

const buildPartyLedger = (partyType, convention) =>
  function build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('jl."tenantId"');
    where.factoryScope('je."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('je."entryDate"', p.dateFrom, p.dateTo);
    where.eq('pt."partyType"', partyType);
    where.eq('jl."partyId"', p.partyId);
    where.eq('je."referenceType"', p.referenceType);
    where.search(['je."narration"', 'je."referenceType"', 'pt."name"', 'a."name"'], p.search);
    where.raw('jl."partyId" IS NOT NULL');

    return {
      from: `
        journal_lines jl
        JOIN journal_entries je ON je.id = jl."journalEntryId"
        JOIN parties pt ON pt.id = jl."partyId"
        JOIN accounts a ON a.id = jl."accountId"
        JOIN factories f ON f.id = je."factoryId"`,
      select: `
        jl.id AS "id",
        je."entryDate",
        pt."name" AS "partyName",
        je."referenceType" AS "transactionType",
        je."narration",
        a."name" AS "accountName",
        jl."debitPaise", jl."creditPaise",
        -- Runs over the whole filtered set before LIMIT, so the balance stays
        -- continuous across pages; anchored to the books' own order rather than
        -- the display sort, so re-sorting cannot change what it means.
        SUM(${convention.balance}) OVER (
          PARTITION BY jl."partyId"
          ORDER BY je."entryDate", je."createdAt", jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "runningBalancePaise",
        f."name" AS "factoryName"`,
      where,
      tieBreak: 'jl.id',
      sortMap: {
        entryDate: 'je."entryDate"',
        partyName: 'pt."name"',
        transactionType: 'je."referenceType"',
        accountName: 'a."name"',
        debitPaise: 'jl."debitPaise"',
        creditPaise: 'jl."creditPaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "entryCount",
        COALESCE(SUM(jl."debitPaise"), 0) AS "debitPaise",
        COALESCE(SUM(jl."creditPaise"), 0) AS "creditPaise",
        COALESCE(SUM(${convention.balance}), 0) AS "closingBalancePaise"`,
    };
  };

const LEDGER_COLUMNS = [
  date('entryDate', 'Date'),
  text('partyName', 'Party'),
  text('transactionType', 'Transaction Type'),
  text('narration', 'Description', { sortable: false }),
  text('accountName', 'Account'),
  money('debitPaise', 'Debit', { total: true }),
  money('creditPaise', 'Credit', { total: true }),
  money('runningBalancePaise', 'Running Balance'),
  text('factoryName', 'Location'),
];

const ledgerSummary = (balanceLabel) => [
  metric('entryCount', 'Entries', 'int'),
  metric('debitPaise', 'Total Debit'),
  metric('creditPaise', 'Total Credit'),
  metric('closingBalancePaise', balanceLabel),
];

const defineLedger = ({ id, category, name, partyType, convention, balanceLabel, partyFilter }) =>
  defineReport({
    id,
    category,
    slug: 'ledger',
    name,
    description: `Statement of account: every posting for the selected ${partyType.toLowerCase()}, with a running balance.`,
    dateFieldLabel: 'Entry Date',
    partyTypeScope: partyType,
    filters: ['dateFrom', 'dateTo', 'factoryId', partyFilter, 'referenceType'],
    searchFields: ['Narration', 'Reference Type', 'Account'],
    defaultSort: { by: 'entryDate', dir: 'desc' },
    columns: LEDGER_COLUMNS,
    summary: ledgerSummary(balanceLabel),
    build: buildPartyLedger(partyType, convention),
  });

// The party filter key differs per category so the UI can label and populate
// the picker correctly, but they all resolve to the same partyId predicate —
// see reports.schema.js.
defineLedger({ id: 'customer-ledger', category: 'customer', name: 'Customer Ledger', partyType: 'CUSTOMER', convention: RECEIVABLE, balanceLabel: 'Closing Balance (Receivable)', partyFilter: 'customerId' });
defineLedger({ id: 'vendor-ledger', category: 'vendor', name: 'Vendor Ledger', partyType: 'VENDOR', convention: PAYABLE, balanceLabel: 'Closing Balance (Payable)', partyFilter: 'vendorId' });
defineLedger({ id: 'contractor-ledger', category: 'contractor', name: 'Contractor Ledger', partyType: 'CONTRACTOR', convention: PAYABLE, balanceLabel: 'Closing Balance (Payable)', partyFilter: 'contractorId' });
defineLedger({ id: 'labour-ledger', category: 'labour', name: 'Labour Ledger', partyType: 'LABOUR', convention: PAYABLE, balanceLabel: 'Closing Balance (Payable)', partyFilter: 'labourId' });

// ---------------------------------------------------------------------------
// Customer summary
// ---------------------------------------------------------------------------

defineReport({
  id: 'customer-summary',
  filterOptions: { status: { label: 'Customer Status', options: VOCABULARY.partyStatus } },
  category: 'customer',
  slug: 'summary',
  name: 'Customer Summary',
  description: 'Every customer with their order and invoice activity, collection and current balance.',
  dateFieldLabel: 'Invoice Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'status'],
  searchFields: ['Customer Name', 'Customer Code', 'Phone', 'GSTIN'],
  defaultSort: { by: 'salesPaise', dir: 'desc' },
  columns: [
    code('customerCode', 'Customer Code'),
    text('customerName', 'Customer'),
    text('phone', 'Contact'),
    text('city', 'Location'),
    int('orderCount', 'Orders'),
    int('invoiceCount', 'Invoices'),
    money('salesPaise', 'Total Sales', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    money('creditLimitPaise', 'Credit Limit', { hidden: true }),
    date('lastSaleDate', 'Last Sale'),
    status('status', 'Status'),
  ],
  summary: [
    metric('customerCount', 'Customers', 'int'),
    metric('invoiceCount', 'Invoices', 'int'),
    metric('salesPaise', 'Total Sales'),
    metric('paidPaise', 'Collected'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('c."tenantId"');
    where.eq('c."partyType"', 'CUSTOMER');
    where.eq('c.id', p.customerId);
    where.token('c."status"', p.status);
    where.search(['c."name"', 'c."code"', 'c."phone"', 'c."gstin"'], p.search);

    // Parties are not factory-scoped, so the scope and the date window apply
    // inside the aggregates. A customer with no activity in the caller's
    // factories therefore shows zeros rather than disappearing — which is the
    // right answer for a master-data list.
    const scope = (alias) => {
      const clauses = [];
      const factory = where.factoryScopeSql(`${alias}."factoryId"`, allowedFactoryIds, p.factoryId);
      if (factory) clauses.push(factory);
      return clauses;
    };
    const invoiceClauses = ['si."customerPartyId" = c.id', `si."status" = 'POSTED'`, ...scope('si')];
    if (p.dateFrom) invoiceClauses.push(`si."invoiceDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) invoiceClauses.push(`si."invoiceDate" <= ${where.param(p.dateTo)}::date`);

    const orderClauses = ['so."customerPartyId" = c.id', `so."status" <> 'CANCELLED'`, ...scope('so')];
    if (p.dateFrom) orderClauses.push(`so."orderDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) orderClauses.push(`so."orderDate" <= ${where.param(p.dateTo)}::date`);

    return {
      from: `
        parties c
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS "invoiceCount",
            COALESCE(SUM(si."totalPaise"), 0) AS "salesPaise",
            COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
            MAX(si."invoiceDate") AS "lastSaleDate"
          FROM sales_invoices si
          LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si.id')}) pay ON TRUE
          WHERE ${invoiceClauses.join(' AND ')}
        ) inv ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS "orderCount" FROM sales_orders so WHERE ${orderClauses.join(' AND ')}
        ) ord ON TRUE`,
      select: `
        c.id AS "id",
        c."code" AS "customerCode", c."name" AS "customerName",
        c."phone", c."city",
        ord."orderCount", inv."invoiceCount",
        inv."salesPaise", inv."paidPaise",
        (inv."salesPaise" - inv."paidPaise") AS "outstandingPaise",
        c."creditLimitPaise",
        inv."lastSaleDate",
        c."status"`,
      where,
      tieBreak: 'c."name"',
      sortMap: {
        customerCode: 'c."code"',
        customerName: 'c."name"',
        city: 'c."city"',
        orderCount: 'ord."orderCount"',
        invoiceCount: 'inv."invoiceCount"',
        salesPaise: 'inv."salesPaise"',
        paidPaise: 'inv."paidPaise"',
        outstandingPaise: '(inv."salesPaise" - inv."paidPaise")',
        creditLimitPaise: 'c."creditLimitPaise"',
        lastSaleDate: 'inv."lastSaleDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "customerCount",
        COALESCE(SUM(inv."invoiceCount"), 0)::int AS "invoiceCount",
        COALESCE(SUM(inv."salesPaise"), 0) AS "salesPaise",
        COALESCE(SUM(inv."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(inv."salesPaise" - inv."paidPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

// ---------------------------------------------------------------------------
// Receivables — registered twice (Customer Outstanding, Finance Receivables)
// because finance and sales both need it; one query, one truth.
// ---------------------------------------------------------------------------

const buildReceivables = function build({ params: p, allowedFactoryIds, where: openWhere }) {
  const where = openWhere('si."tenantId"');
  where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
  where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
  where.eq('si."customerPartyId"', p.customerId);
  where.token('si."status"', 'POSTED');
  where.search(['si."invoiceNumber"', 'c."name"', 'c."code"'], p.search);
  // Only open documents: a settled invoice is not a receivable.
  where.raw('(si."totalPaise" - pay."paidPaise") > 0');

  const dueDate = salesDueDate('si."invoiceDate"', 'c');
  const days = daysOutstanding(dueDate);
  if (p.overdueOnly === true || p.overdueOnly === 'true') where.raw(`${days} > 0`);

  return {
    from: `
      sales_invoices si
      JOIN parties c ON c.id = si."customerPartyId"
      JOIN factories f ON f.id = si."factoryId"
      LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si.id')}) pay ON TRUE`,
    select: `
      si.id AS "id",
      c."code" AS "customerCode", c."name" AS "customerName",
      si."invoiceNumber", si."invoiceDate",
      si."totalPaise" AS "invoiceAmountPaise",
      pay."paidPaise",
      (si."totalPaise" - pay."paidPaise") AS "outstandingPaise",
      ${dueDate} AS "dueDate",
      ${days} AS "daysOutstanding",
      ${ageingBucket(days)} AS "ageBucket",
      f."name" AS "factoryName"`,
    where,
    tieBreak: 'si.id',
    sortMap: {
      customerCode: 'c."code"',
      customerName: 'c."name"',
      invoiceNumber: 'si."invoiceNumber"',
      invoiceDate: 'si."invoiceDate"',
      invoiceAmountPaise: 'si."totalPaise"',
      paidPaise: 'pay."paidPaise"',
      outstandingPaise: '(si."totalPaise" - pay."paidPaise")',
      dueDate,
      daysOutstanding: days,
      factoryName: 'f."name"',
    },
    summarySelect: `
      COUNT(*)::int AS "invoiceCount",
      COUNT(DISTINCT si."customerPartyId")::int AS "customerCount",
      COALESCE(SUM(si."totalPaise"), 0) AS "invoiceAmountPaise",
      COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
      COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0) AS "outstandingPaise",
      COALESCE(SUM(si."totalPaise" - pay."paidPaise") FILTER (WHERE ${days} > 0), 0) AS "overduePaise"`,
  };
};

const RECEIVABLE_COLUMNS = [
  code('customerCode', 'Customer Code'),
  text('customerName', 'Customer'),
  code('invoiceNumber', 'Invoice No'),
  date('invoiceDate', 'Invoice Date'),
  money('invoiceAmountPaise', 'Invoice Amount', { total: true }),
  money('paidPaise', 'Paid', { total: true }),
  money('outstandingPaise', 'Outstanding', { total: true }),
  date('dueDate', 'Due Date'),
  int('daysOutstanding', 'Days Outstanding'),
  status('ageBucket', 'Age Bucket'),
  text('factoryName', 'Location'),
];

const RECEIVABLE_SUMMARY = [
  metric('invoiceCount', 'Open Invoices', 'int'),
  metric('customerCount', 'Customers', 'int'),
  metric('invoiceAmountPaise', 'Invoiced'),
  metric('paidPaise', 'Paid'),
  metric('outstandingPaise', 'Outstanding'),
  metric('overduePaise', 'Overdue'),
];

const RECEIVABLE_LIMITATION =
  'The due date is derived from the customer master\'s configured credit period (creditAgeingDays), because sales invoices ' +
  'carry no due-date column. A customer with no credit period configured is treated as due on the invoice date.';

for (const [id, category, name] of [
  ['customer-outstanding', 'customer', 'Customer Outstanding'],
  ['receivables', 'finance', 'Receivables'],
]) {
  defineReport({
    id,
    category,
    slug: category === 'finance' ? 'receivables' : 'outstanding',
    name,
    description: 'Open sales invoices with what is still owed on each, aged from its due date.',
    dateFieldLabel: 'Invoice Date',
    limitations: [RECEIVABLE_LIMITATION],
    filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'overdueOnly'],
    searchFields: ['Invoice No', 'Customer Name', 'Customer Code'],
    defaultSort: { by: 'daysOutstanding', dir: 'desc' },
    columns: RECEIVABLE_COLUMNS,
    summary: RECEIVABLE_SUMMARY,
    build: buildReceivables,
  });
}

// ---------------------------------------------------------------------------
// Vendor summary + payables
// ---------------------------------------------------------------------------

defineReport({
  id: 'vendor-summary',
  filterOptions: { status: { label: 'Vendor Status', options: VOCABULARY.partyStatus } },
  category: 'vendor',
  slug: 'summary',
  name: 'Vendor Summary',
  description: 'Every vendor with their purchase activity, payments made and current balance.',
  dateFieldLabel: 'Invoice Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId', 'status'],
  searchFields: ['Vendor Name', 'Vendor Code', 'Phone', 'GSTIN'],
  defaultSort: { by: 'purchasePaise', dir: 'desc' },
  columns: [
    code('vendorCode', 'Vendor Code'),
    text('vendorName', 'Vendor'),
    text('phone', 'Contact'),
    text('city', 'Location'),
    int('purchaseCount', 'Purchases'),
    money('purchasePaise', 'Purchase Amount', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    date('lastPurchaseDate', 'Last Purchase'),
    status('status', 'Status'),
  ],
  summary: [
    metric('vendorCount', 'Vendors', 'int'),
    metric('purchaseCount', 'Purchases', 'int'),
    metric('purchasePaise', 'Purchase Amount'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('v."tenantId"');
    where.eq('v."partyType"', 'VENDOR');
    where.eq('v.id', p.vendorId);
    where.token('v."status"', p.status);
    where.search(['v."name"', 'v."code"', 'v."phone"', 'v."gstin"'], p.search);

    const clauses = ['pi."vendorPartyId" = v.id', `pi."status" = 'POSTED'`];
    const factory = where.factoryScopeSql('pi."factoryId"', allowedFactoryIds, p.factoryId);
    if (factory) clauses.push(factory);
    if (p.dateFrom) clauses.push(`pi."invoiceDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) clauses.push(`pi."invoiceDate" <= ${where.param(p.dateTo)}::date`);

    return {
      from: `
        parties v
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS "purchaseCount",
            COALESCE(SUM(pi."amountPaise"), 0) AS "purchasePaise",
            COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
            MAX(pi."invoiceDate") AS "lastPurchaseDate"
          FROM purchase_invoices pi
          LEFT JOIN LATERAL (${allocatedAmount('PURCHASE', 'pi.id')}) pay ON TRUE
          WHERE ${clauses.join(' AND ')}
        ) agg ON TRUE`,
      select: `
        v.id AS "id",
        v."code" AS "vendorCode", v."name" AS "vendorName",
        v."phone", v."city",
        agg."purchaseCount", agg."purchasePaise", agg."paidPaise",
        (agg."purchasePaise" - agg."paidPaise") AS "outstandingPaise",
        agg."lastPurchaseDate",
        v."status"`,
      where,
      tieBreak: 'v."name"',
      sortMap: {
        vendorCode: 'v."code"',
        vendorName: 'v."name"',
        city: 'v."city"',
        purchaseCount: 'agg."purchaseCount"',
        purchasePaise: 'agg."purchasePaise"',
        paidPaise: 'agg."paidPaise"',
        outstandingPaise: '(agg."purchasePaise" - agg."paidPaise")',
        lastPurchaseDate: 'agg."lastPurchaseDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "vendorCount",
        COALESCE(SUM(agg."purchaseCount"), 0)::int AS "purchaseCount",
        COALESCE(SUM(agg."purchasePaise"), 0) AS "purchasePaise",
        COALESCE(SUM(agg."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(agg."purchasePaise" - agg."paidPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

const buildPayables = function build({ params: p, allowedFactoryIds, where: openWhere }) {
  const where = openWhere('pi."tenantId"');
  where.raw(`pi."status" = 'POSTED'`);
  where.factoryScope('pi."factoryId"', allowedFactoryIds, p.factoryId);
  where.dateRange('pi."invoiceDate"', p.dateFrom, p.dateTo);
  where.eq('pi."vendorPartyId"', p.vendorId);
  where.search(['pi."vendorInvoiceNumber"', 'v."name"', 'v."code"'], p.search);
  where.raw('(pi."amountPaise" - pay."paidPaise") > 0');

  // Unlike sales, purchase invoices carry a real dueDate. Fall back to the
  // invoice date when it is absent rather than treating it as never due.
  const dueDate = 'COALESCE(pi."dueDate", pi."invoiceDate")';
  const days = daysOutstanding(dueDate);
  if (p.overdueOnly === true || p.overdueOnly === 'true') where.raw(`${days} > 0`);

  return {
    from: `
      purchase_invoices pi
      JOIN parties v ON v.id = pi."vendorPartyId"
      JOIN factories f ON f.id = pi."factoryId"
      LEFT JOIN LATERAL (${allocatedAmount('PURCHASE', 'pi.id')}) pay ON TRUE`,
    select: `
      pi.id AS "id",
      v."code" AS "vendorCode", v."name" AS "vendorName",
      pi."vendorInvoiceNumber" AS "purchaseNumber", pi."invoiceDate" AS "purchaseDate",
      pi."amountPaise" AS "purchaseAmountPaise",
      pay."paidPaise",
      (pi."amountPaise" - pay."paidPaise") AS "outstandingPaise",
      ${dueDate} AS "dueDate",
      ${days} AS "daysOutstanding",
      ${ageingBucket(days)} AS "ageBucket",
      f."name" AS "factoryName"`,
    where,
    tieBreak: 'pi.id',
    sortMap: {
      vendorCode: 'v."code"',
      vendorName: 'v."name"',
      purchaseNumber: 'pi."vendorInvoiceNumber"',
      purchaseDate: 'pi."invoiceDate"',
      purchaseAmountPaise: 'pi."amountPaise"',
      paidPaise: 'pay."paidPaise"',
      outstandingPaise: '(pi."amountPaise" - pay."paidPaise")',
      dueDate,
      daysOutstanding: days,
      factoryName: 'f."name"',
    },
    summarySelect: `
      COUNT(*)::int AS "purchaseCount",
      COUNT(DISTINCT pi."vendorPartyId")::int AS "vendorCount",
      COALESCE(SUM(pi."amountPaise"), 0) AS "purchaseAmountPaise",
      COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
      COALESCE(SUM(pi."amountPaise" - pay."paidPaise"), 0) AS "outstandingPaise",
      COALESCE(SUM(pi."amountPaise" - pay."paidPaise") FILTER (WHERE ${days} > 0), 0) AS "overduePaise"`,
  };
};

const PAYABLE_COLUMNS = [
  code('vendorCode', 'Vendor Code'),
  text('vendorName', 'Vendor'),
  code('purchaseNumber', 'Purchase No'),
  date('purchaseDate', 'Purchase Date'),
  money('purchaseAmountPaise', 'Purchase Amount', { total: true }),
  money('paidPaise', 'Paid', { total: true }),
  money('outstandingPaise', 'Outstanding', { total: true }),
  date('dueDate', 'Due Date'),
  int('daysOutstanding', 'Days Outstanding'),
  status('ageBucket', 'Age Bucket'),
  text('factoryName', 'Location'),
];

const PAYABLE_SUMMARY = [
  metric('purchaseCount', 'Open Purchases', 'int'),
  metric('vendorCount', 'Vendors', 'int'),
  metric('purchaseAmountPaise', 'Purchased'),
  metric('paidPaise', 'Paid'),
  metric('outstandingPaise', 'Outstanding'),
  metric('overduePaise', 'Overdue'),
];

for (const [id, category, name] of [
  ['vendor-outstanding', 'vendor', 'Vendor Outstanding'],
  ['payables', 'finance', 'Payables'],
]) {
  defineReport({
    id,
    category,
    slug: category === 'finance' ? 'payables' : 'outstanding',
    name,
    description: 'Open purchase invoices with what is still owed on each, aged from its due date.',
    dateFieldLabel: 'Invoice Date',
    filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId', 'overdueOnly'],
    searchFields: ['Purchase No', 'Vendor Name', 'Vendor Code'],
    defaultSort: { by: 'daysOutstanding', dir: 'desc' },
    columns: PAYABLE_COLUMNS,
    summary: PAYABLE_SUMMARY,
    build: buildPayables,
  });
}

// ---------------------------------------------------------------------------
// Contractor production + outstanding
// ---------------------------------------------------------------------------

defineReport({
  id: 'contractor-production',
  category: 'contractor',
  slug: 'production',
  name: 'Contractor Production',
  description: 'Every job-work production entry, with the piece rate it was valued at.',
  dateFieldLabel: 'Production Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'contractorId', 'productId', 'categoryId', 'status'],
  searchFields: ['Production No', 'Contractor Name', 'Product Name'],
  defaultSort: { by: 'productionDate', dir: 'desc' },
  columns: [
    code('entryNumber', 'Production No'),
    date('productionDate', 'Date'),
    code('contractorCode', 'Contractor Code'),
    text('contractorName', 'Contractor'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    code('uomCode', 'UOM'),
    qty('quantity', 'Quantity'),
    money('pieceRatePaise', 'Rate'),
    money('totalValuePaise', 'Production Value', { total: true }),
    code('lotNumber', 'Lot', { hidden: true }),
    text('factoryName', 'Location'),
    status('status', 'Status'),
  ],
  summary: [
    metric('entryCount', 'Entries', 'int'),
    metric('contractorCount', 'Contractors', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('totalValuePaise', 'Production Value'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('cpe."tenantId"');
    where.factoryScope('cpe."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('cpe."productionDate"', p.dateFrom, p.dateTo);
    where.eq('cpe."contractorPartyId"', p.contractorId);
    where.eq('cpe."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('cpe."status"', p.status || 'POSTED');
    where.search(['cpe."entryNumber"', 'ct."name"', 'pr."name"', 'pr."code"'], p.search);

    return {
      from: `
        contractor_production_entries cpe
        JOIN parties ct ON ct.id = cpe."contractorPartyId"
        JOIN products pr ON pr.id = cpe."productId"
        JOIN factories f ON f.id = cpe."factoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN stock_lots sl ON sl.id = cpe."lotId"`,
      select: `
        cpe.id AS "id",
        cpe."entryNumber", cpe."productionDate",
        ct."code" AS "contractorCode", ct."name" AS "contractorName",
        pr."code" AS "productCode", pr."name" AS "productName", u."code" AS "uomCode",
        cpe.quantity, cpe."pieceRatePaise", cpe."totalValuePaise",
        sl."lotNumber",
        f."name" AS "factoryName",
        cpe."status"`,
      where,
      tieBreak: 'cpe.id',
      sortMap: {
        entryNumber: 'cpe."entryNumber"',
        productionDate: 'cpe."productionDate"',
        contractorName: 'ct."name"',
        contractorCode: 'ct."code"',
        productName: 'pr."name"',
        productCode: 'pr."code"',
        quantity: 'cpe.quantity',
        pieceRatePaise: 'cpe."pieceRatePaise"',
        totalValuePaise: 'cpe."totalValuePaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "entryCount",
        COUNT(DISTINCT cpe."contractorPartyId")::int AS "contractorCount",
        COALESCE(SUM(cpe.quantity), 0) AS "quantity",
        COALESCE(SUM(cpe."totalValuePaise"), 0) AS "totalValuePaise"`,
    };
  },
});

/**
 * Contractor and labour dues, from the books rather than the documents.
 *
 * There is no allocation table for job-work or wages the way there is for sales
 * and purchase invoices — a contractor payment is not tied to a specific
 * production entry. So "paid" cannot be attributed per document; it is the
 * total debited to that party's payable account, which is exactly what they
 * have been given. That makes this a party-level report, not a document-level
 * one, and it is honest about being so.
 */
const buildPartyDues = (partyType, labels) =>
  function build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pt."tenantId"');
    where.eq('pt."partyType"', partyType);
    where.eq('pt.id', p.partyId || p.contractorId || p.labourId);
    where.token('pt."status"', p.status);
    where.search(['pt."name"', 'pt."code"', 'pt."phone"'], p.search);

    const clauses = ['jl."partyId" = pt.id'];
    const factory = where.factoryScopeSql('je."factoryId"', allowedFactoryIds, p.factoryId);
    if (factory) clauses.push(factory);
    if (p.dateFrom) clauses.push(`je."entryDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) clauses.push(`je."entryDate" <= ${where.param(p.dateTo)}::date`);

    return {
      from: `
        parties pt
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(jl."creditPaise"), 0) AS "earnedPaise",
            COALESCE(SUM(jl."debitPaise"), 0) AS "paidPaise",
            MAX(je."entryDate") FILTER (WHERE jl."debitPaise" > 0) AS "lastPaymentDate",
            COUNT(*)::int AS "entryCount"
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl."journalEntryId"
          WHERE ${clauses.join(' AND ')}
        ) bal ON TRUE`,
      select: `
        pt.id AS "id",
        pt."code" AS "partyCode", pt."name" AS "partyName", pt."phone",
        bal."entryCount",
        bal."earnedPaise" AS "${labels.earnedKey}",
        bal."paidPaise",
        GREATEST(bal."earnedPaise" - bal."paidPaise", 0) AS "outstandingPaise",
        bal."lastPaymentDate",
        pt."status"`,
      where,
      tieBreak: 'pt."name"',
      sortMap: {
        partyCode: 'pt."code"',
        partyName: 'pt."name"',
        entryCount: 'bal."entryCount"',
        [labels.earnedKey]: 'bal."earnedPaise"',
        paidPaise: 'bal."paidPaise"',
        outstandingPaise: 'GREATEST(bal."earnedPaise" - bal."paidPaise", 0)',
        lastPaymentDate: 'bal."lastPaymentDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "partyCount",
        COALESCE(SUM(bal."earnedPaise"), 0) AS "${labels.earnedKey}",
        COALESCE(SUM(bal."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(GREATEST(bal."earnedPaise" - bal."paidPaise", 0)), 0) AS "outstandingPaise"`,
    };
  };

defineReport({
  id: 'contractor-outstanding',
  filterOptions: { status: { label: 'Contractor Status', options: VOCABULARY.partyStatus } },
  category: 'contractor',
  slug: 'outstanding',
  name: 'Contractor Outstanding',
  description: 'What each contractor has earned against what they have been paid.',
  dateFieldLabel: 'Entry Date',
  partyTypeScope: 'CONTRACTOR',
  limitations: [
    'Dues are shown per contractor, not per production entry: contractor payments are not allocated to specific job-work ' +
      'documents, so there is no per-document paid figure to report.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'contractorId', 'status'],
  searchFields: ['Contractor Name', 'Contractor Code'],
  defaultSort: { by: 'outstandingPaise', dir: 'desc' },
  columns: [
    code('partyCode', 'Contractor Code'),
    text('partyName', 'Contractor'),
    text('phone', 'Contact'),
    int('entryCount', 'Ledger Entries'),
    money('totalValuePaise', 'Total Value', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    date('lastPaymentDate', 'Last Payment'),
    status('status', 'Status'),
  ],
  summary: [
    metric('partyCount', 'Contractors', 'int'),
    metric('totalValuePaise', 'Total Value'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build: buildPartyDues('CONTRACTOR', { earnedKey: 'totalValuePaise' }),
});
