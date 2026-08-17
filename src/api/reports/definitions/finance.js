const { defineReport } = require('../lib/registry');
const { VOCABULARY } = require('../lib/filters');
const { text, code, date, money, int, percent, status, metric } = require('../lib/columns');
const { modeAmount, modeList, PAYMENT_MODES } = require('../lib/fragments');
const { SystemAccounts } = require('../../ledger/systemAccounts');

/**
 * Payment, expense and finance reports.
 *
 * Money-in and money-out live in two tables (receipts and payments) that are
 * structurally identical, so the register unions them rather than shipping two
 * near-identical reports. Cash flow and the day book read the journal directly,
 * which is the only place that is guaranteed to balance.
 *
 * Payment modes are read from the `modes` JSONB each document carries, and only
 * the four the system actually supports are shown (payments.schema.js:
 * CASH, UPI, BANK, CHEQUE) — no invented "Other" column.
 */

const CASH_CODE = SystemAccounts.CASH.code;
const BANK_CODE = SystemAccounts.BANK.code;

const NO_CREATED_BY =
  'Created By is not shown: receipts and payments do not record the user who raised them (the audit log does, per document).';

/**
 * Receipts and payments as one stream. Both carry the same shape; `direction`
 * is what tells them apart.
 *
 * `status` is cast to text on both sides because receipts and payments have
 * structurally identical but *distinct* Postgres enum types
 * (enum_receipts_status, enum_payments_status), and a UNION will not implicitly
 * convert between two enums even when their labels match.
 */
const MONEY_DOCUMENTS = `
  (
    SELECT r.id, r."tenantId", r."factoryId",
           r."receiptNumber" AS "documentNumber", r."receiptDate" AS "documentDate",
           'RECEIPT'::text AS "direction", r."customerPartyId" AS "partyId",
           r."modes", r."totalAmountPaise", r."unallocatedAmountPaise", r."status"::text AS "status"
    FROM receipts r
    UNION ALL
    SELECT pm.id, pm."tenantId", pm."factoryId",
           pm."paymentNumber", pm."paymentDate",
           'PAYMENT'::text, pm."partyId",
           pm."modes", pm."totalAmountPaise", pm."unallocatedAmountPaise", pm."status"::text
    FROM payments pm
  ) doc`;

defineReport({
  id: 'payments-register',
  category: 'payment',
  slug: 'register',
  name: 'Payment Register',
  description: 'Every receipt and payment, with how much of each has been allocated to a document.',
  dateFieldLabel: 'Payment Date',
  limitations: [NO_CREATED_BY],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'partyId', 'direction', 'paymentMode', 'status'],
  searchFields: ['Payment No', 'Party Name', 'Party Code'],
  defaultSort: { by: 'documentDate', dir: 'desc' },
  columns: [
    code('documentNumber', 'Payment No'),
    date('documentDate', 'Payment Date'),
    status('direction', 'Direction'),
    text('partyType', 'Party Type'),
    code('partyCode', 'Party Code'),
    text('partyName', 'Party'),
    text('paymentModes', 'Payment Mode', { sortable: false }),
    money('totalAmountPaise', 'Amount', { total: true }),
    money('allocatedAmountPaise', 'Allocated', { total: true }),
    money('unallocatedAmountPaise', 'Unallocated', { total: true }),
    text('factoryName', 'Location'),
    status('status', 'Status'),
  ],
  summary: [
    metric('documentCount', 'Documents', 'int'),
    metric('receiptPaise', 'Money In'),
    metric('paymentPaise', 'Money Out'),
    metric('netPaise', 'Net'),
    metric('unallocatedAmountPaise', 'Unallocated'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('doc."tenantId"');
    where.factoryScope('doc."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('doc."documentDate"', p.dateFrom, p.dateTo);
    where.eq('doc."partyId"', p.partyId);
    where.eq('doc."direction"', p.direction);
    where.token('doc."status"', p.status || 'POSTED');
    where.search(['doc."documentNumber"', 'pt."name"', 'pt."code"'], p.search);
    if (p.paymentMode) {
      where.raw(`EXISTS (SELECT 1 FROM jsonb_array_elements(doc."modes") m WHERE m->>'mode' = ${where.param(p.paymentMode)})`);
    }

    const allocated = '(doc."totalAmountPaise" - doc."unallocatedAmountPaise")';

    return {
      from: `
        ${MONEY_DOCUMENTS}
        JOIN parties pt ON pt.id = doc."partyId"
        JOIN factories f ON f.id = doc."factoryId"`,
      select: `
        doc.id AS "id",
        doc."documentNumber", doc."documentDate", doc."direction",
        pt."partyType", pt."code" AS "partyCode", pt."name" AS "partyName",
        ${modeList('doc."modes"')} AS "paymentModes",
        doc."totalAmountPaise",
        ${allocated} AS "allocatedAmountPaise",
        doc."unallocatedAmountPaise",
        f."name" AS "factoryName",
        doc."status"`,
      where,
      tieBreak: 'doc.id',
      sortMap: {
        documentNumber: 'doc."documentNumber"',
        documentDate: 'doc."documentDate"',
        direction: 'doc."direction"',
        partyType: 'pt."partyType"',
        partyName: 'pt."name"',
        partyCode: 'pt."code"',
        totalAmountPaise: 'doc."totalAmountPaise"',
        allocatedAmountPaise: allocated,
        unallocatedAmountPaise: 'doc."unallocatedAmountPaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "documentCount",
        COALESCE(SUM(doc."totalAmountPaise") FILTER (WHERE doc."direction" = 'RECEIPT'), 0) AS "receiptPaise",
        COALESCE(SUM(doc."totalAmountPaise") FILTER (WHERE doc."direction" = 'PAYMENT'), 0) AS "paymentPaise",
        COALESCE(SUM(CASE WHEN doc."direction" = 'RECEIPT' THEN doc."totalAmountPaise" ELSE -doc."totalAmountPaise" END), 0) AS "netPaise",
        COALESCE(SUM(doc."unallocatedAmountPaise"), 0) AS "unallocatedAmountPaise"`,
    };
  },
});

defineReport({
  id: 'payment-modes',
  category: 'payment',
  slug: 'modes',
  name: 'Payment Mode Report',
  description: 'Receipts and payments split across the four modes the system supports.',
  dateFieldLabel: 'Payment Date',
  limitations: ['Only CASH, UPI, BANK and CHEQUE are shown — those are the modes this system records.'],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'partyId', 'direction'],
  searchFields: ['Payment No', 'Party Name'],
  defaultSort: { by: 'documentDate', dir: 'desc' },
  columns: [
    date('documentDate', 'Date'),
    code('documentNumber', 'Payment No'),
    status('direction', 'Direction'),
    text('partyName', 'Party'),
    ...PAYMENT_MODES.map((mode) =>
      money(`mode${mode.charAt(0)}${mode.slice(1).toLowerCase()}Paise`, mode.charAt(0) + mode.slice(1).toLowerCase(), { total: true })
    ),
    money('totalAmountPaise', 'Total', { total: true }),
    text('factoryName', 'Location'),
  ],
  summary: [
    metric('documentCount', 'Documents', 'int'),
    ...PAYMENT_MODES.map((mode) => metric(`mode${mode.charAt(0)}${mode.slice(1).toLowerCase()}Paise`, mode.charAt(0) + mode.slice(1).toLowerCase())),
    metric('totalAmountPaise', 'Total'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('doc."tenantId"');
    where.factoryScope('doc."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('doc."documentDate"', p.dateFrom, p.dateTo);
    where.eq('doc."partyId"', p.partyId);
    where.eq('doc."direction"', p.direction);
    where.token('doc."status"', 'POSTED');
    where.search(['doc."documentNumber"', 'pt."name"'], p.search);

    const modeKey = (mode) => `mode${mode.charAt(0)}${mode.slice(1).toLowerCase()}Paise`;
    const modeColumns = PAYMENT_MODES.map((mode) => `${modeAmount('doc."modes"', mode)} AS "${modeKey(mode)}"`).join(',\n        ');
    const modeSummary = PAYMENT_MODES.map((mode) => `COALESCE(SUM(${modeAmount('doc."modes"', mode)}), 0) AS "${modeKey(mode)}"`).join(',\n        ');

    return {
      from: `
        ${MONEY_DOCUMENTS}
        JOIN parties pt ON pt.id = doc."partyId"
        JOIN factories f ON f.id = doc."factoryId"`,
      select: `
        doc.id AS "id",
        doc."documentDate", doc."documentNumber", doc."direction",
        pt."name" AS "partyName",
        ${modeColumns},
        doc."totalAmountPaise",
        f."name" AS "factoryName"`,
      where,
      tieBreak: 'doc.id',
      sortMap: {
        documentDate: 'doc."documentDate"',
        documentNumber: 'doc."documentNumber"',
        direction: 'doc."direction"',
        partyName: 'pt."name"',
        totalAmountPaise: 'doc."totalAmountPaise"',
        factoryName: 'f."name"',
        ...Object.fromEntries(PAYMENT_MODES.map((mode) => [modeKey(mode), modeAmount('doc."modes"', mode)])),
      },
      summarySelect: `
        COUNT(*)::int AS "documentCount",
        ${modeSummary},
        COALESCE(SUM(doc."totalAmountPaise"), 0) AS "totalAmountPaise"`,
    };
  },
});

defineReport({
  id: 'collections',
  category: 'payment',
  slug: 'collections',
  name: 'Collection Report',
  description: 'Customer money received, matched to the invoice each allocation settled.',
  dateFieldLabel: 'Receipt Date',
  limitations: ['Sales Reference is not shown: no sales document carries a sales-reference party.'],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'paymentMode'],
  searchFields: ['Receipt No', 'Invoice No', 'Customer Name'],
  defaultSort: { by: 'receiptDate', dir: 'desc' },
  columns: [
    date('receiptDate', 'Date'),
    code('receiptNumber', 'Payment No'),
    code('customerCode', 'Customer Code'),
    text('customerName', 'Customer'),
    code('invoiceNumber', 'Invoice No'),
    date('invoiceDate', 'Invoice Date'),
    text('paymentModes', 'Payment Mode', { sortable: false }),
    money('allocatedAmountPaise', 'Amount', { total: true }),
    text('factoryName', 'Location'),
  ],
  summary: [
    metric('allocationCount', 'Collections', 'int'),
    metric('customerCount', 'Customers', 'int'),
    metric('allocatedAmountPaise', 'Collected'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pa."tenantId"');
    where.factoryScope('r."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('r."receiptDate"', p.dateFrom, p.dateTo);
    where.eq('r."customerPartyId"', p.customerId);
    where.token('r."status"', 'POSTED');
    where.eq('pa."invoiceType"', 'SALES');
    where.search(['r."receiptNumber"', 'si."invoiceNumber"', 'c."name"'], p.search);
    if (p.paymentMode) {
      where.raw(`EXISTS (SELECT 1 FROM jsonb_array_elements(r."modes") m WHERE m->>'mode' = ${where.param(p.paymentMode)})`);
    }

    return {
      from: `
        payment_allocations pa
        JOIN receipts r ON r.id = pa."receiptId"
        JOIN parties c ON c.id = r."customerPartyId"
        JOIN factories f ON f.id = r."factoryId"
        LEFT JOIN sales_invoices si ON si.id = pa."invoiceId"`,
      select: `
        pa.id AS "id",
        r."receiptDate", r."receiptNumber",
        c."code" AS "customerCode", c."name" AS "customerName",
        si."invoiceNumber", si."invoiceDate",
        ${modeList('r."modes"')} AS "paymentModes",
        pa."allocatedAmountPaise",
        f."name" AS "factoryName"`,
      where,
      tieBreak: 'pa.id',
      sortMap: {
        receiptDate: 'r."receiptDate"',
        receiptNumber: 'r."receiptNumber"',
        customerName: 'c."name"',
        customerCode: 'c."code"',
        invoiceNumber: 'si."invoiceNumber"',
        invoiceDate: 'si."invoiceDate"',
        allocatedAmountPaise: 'pa."allocatedAmountPaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "allocationCount",
        COUNT(DISTINCT r."customerPartyId")::int AS "customerCount",
        COALESCE(SUM(pa."allocatedAmountPaise"), 0) AS "allocatedAmountPaise"`,
    };
  },
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

defineReport({
  id: 'expenses-register',
  filterOptions: { paymentMode: { options: VOCABULARY.cashMode } },
  category: 'expense',
  slug: 'register',
  name: 'Expense Report',
  description: 'Every factory expense with its category, how it was paid and who it was paid to.',
  dateFieldLabel: 'Expense Date',
  limitations: [NO_CREATED_BY],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'expenseCategory', 'paymentMode', 'partyId', 'status'],
  searchFields: ['Expense No', 'Category', 'Description'],
  defaultSort: { by: 'expenseDate', dir: 'desc' },
  columns: [
    code('expenseNumber', 'Expense No'),
    date('expenseDate', 'Date'),
    text('category', 'Expense Category'),
    text('description', 'Description', { sortable: false }),
    text('factoryName', 'Location'),
    money('amountPaise', 'Amount', { total: true }),
    text('mode', 'Payment Mode'),
    text('paidToName', 'Paid To'),
    status('status', 'Status'),
  ],
  summary: [
    metric('expenseCount', 'Expenses', 'int'),
    metric('categoryCount', 'Categories', 'int'),
    metric('amountPaise', 'Total Expense'),
    metric('cashPaise', 'Paid by Cash'),
    metric('bankPaise', 'Paid by Bank'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('ex."tenantId"');
    where.factoryScope('ex."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('ex."expenseDate"', p.dateFrom, p.dateTo);
    where.eq('ex."category"', p.expenseCategory);
    where.token('ex."mode"', p.paymentMode);
    where.eq('ex."paidToPartyId"', p.partyId);
    where.token('ex."status"', p.status || 'POSTED');
    where.search(['ex."expenseNumber"', 'ex."category"', 'ex."description"'], p.search);

    return {
      from: `
        expenses ex
        JOIN factories f ON f.id = ex."factoryId"
        LEFT JOIN parties pt ON pt.id = ex."paidToPartyId"`,
      select: `
        ex.id AS "id",
        ex."expenseNumber", ex."expenseDate", ex."category", ex."description",
        f."name" AS "factoryName",
        ex."amountPaise", ex."mode",
        pt."name" AS "paidToName",
        ex."status"`,
      where,
      tieBreak: 'ex.id',
      sortMap: {
        expenseNumber: 'ex."expenseNumber"',
        expenseDate: 'ex."expenseDate"',
        category: 'ex."category"',
        factoryName: 'f."name"',
        amountPaise: 'ex."amountPaise"',
        mode: 'ex."mode"',
        paidToName: 'pt."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "expenseCount",
        COUNT(DISTINCT ex."category")::int AS "categoryCount",
        COALESCE(SUM(ex."amountPaise"), 0) AS "amountPaise",
        COALESCE(SUM(ex."amountPaise") FILTER (WHERE ex."mode" = 'CASH'), 0) AS "cashPaise",
        COALESCE(SUM(ex."amountPaise") FILTER (WHERE ex."mode" = 'BANK'), 0) AS "bankPaise"`,
    };
  },
});

defineReport({
  id: 'expenses-by-category',
  filterOptions: { paymentMode: { options: VOCABULARY.cashMode } },
  category: 'expense',
  slug: 'by-category',
  name: 'Expense by Category',
  description: 'Where the money went, by category, with each category as a share of the total.',
  dateFieldLabel: 'Expense Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'expenseCategory', 'paymentMode'],
  searchFields: ['Category'],
  defaultSort: { by: 'amountPaise', dir: 'desc' },
  columns: [
    text('category', 'Category'),
    int('transactionCount', 'Transactions'),
    money('amountPaise', 'Total Amount', { total: true }),
    percent('percentOfTotal', '% of Total'),
    money('cashPaise', 'Cash', { hidden: true }),
    money('bankPaise', 'Bank', { hidden: true }),
    date('lastExpenseDate', 'Last Expense'),
  ],
  summary: [
    metric('categoryCount', 'Categories', 'int'),
    metric('transactionCount', 'Transactions', 'int'),
    metric('amountPaise', 'Total Expense'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('ex."tenantId"');
    where.factoryScope('ex."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('ex."expenseDate"', p.dateFrom, p.dateTo);
    where.eq('ex."category"', p.expenseCategory);
    where.token('ex."mode"', p.paymentMode);
    where.token('ex."status"', 'POSTED');
    where.search(['ex."category"'], p.search);

    return {
      from: 'expenses ex',
      select: `
        ex."category" AS "id",
        ex."category",
        COUNT(*)::int AS "transactionCount",
        COALESCE(SUM(ex."amountPaise"), 0) AS "amountPaise",
        -- Share of the filtered total, computed with a window over the grouped
        -- rows so the percentages add to 100 for the report the reader is
        -- looking at rather than for all expenses ever recorded.
        CASE WHEN SUM(SUM(ex."amountPaise")) OVER () = 0 THEN 0
             ELSE ROUND(100.0 * SUM(ex."amountPaise") / SUM(SUM(ex."amountPaise")) OVER (), 2) END AS "percentOfTotal",
        COALESCE(SUM(ex."amountPaise") FILTER (WHERE ex."mode" = 'CASH'), 0) AS "cashPaise",
        COALESCE(SUM(ex."amountPaise") FILTER (WHERE ex."mode" = 'BANK'), 0) AS "bankPaise",
        MAX(ex."expenseDate") AS "lastExpenseDate"`,
      where,
      groupBy: 'ex."category"',
      tieBreak: 'ex."category"',
      sortMap: {
        category: 'ex."category"',
        transactionCount: 'COUNT(*)',
        amountPaise: 'COALESCE(SUM(ex."amountPaise"), 0)',
        lastExpenseDate: 'MAX(ex."expenseDate")',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "categoryCount",
        COALESCE(SUM(_s."transactionCount"), 0)::int AS "transactionCount",
        COALESCE(SUM(_s."amountPaise"), 0) AS "amountPaise"`,
    };
  },
});

// ---------------------------------------------------------------------------
// Cash flow and day book
// ---------------------------------------------------------------------------

defineReport({
  id: 'cash-flow',
  category: 'finance',
  slug: 'cash-flow',
  name: 'Cash Flow',
  description: 'Day-by-day cash and bank position per location: opening, in, out, closing.',
  dateFieldLabel: 'Entry Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'accountKey'],
  searchFields: [],
  defaultSort: { by: 'entryDate', dir: 'desc' },
  columns: [
    date('entryDate', 'Date'),
    text('factoryName', 'Location'),
    money('openingPaise', 'Opening'),
    money('cashInPaise', 'Cash In', { total: true }),
    money('cashOutPaise', 'Cash Out', { total: true }),
    money('closingPaise', 'Closing'),
    int('entryCount', 'Entries', { hidden: true }),
  ],
  summary: [
    metric('dayCount', 'Days', 'int'),
    metric('cashInPaise', 'Total In'),
    metric('cashOutPaise', 'Total Out'),
    metric('netPaise', 'Net Movement'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('jl."tenantId"');
    where.factoryScope('je."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('je."entryDate"', p.dateFrom, p.dateTo);

    // Which liquid accounts count. Defaults to both, which is what "cash flow"
    // means to the people reading it.
    const codes = p.accountKey === 'CASH' ? [CASH_CODE] : p.accountKey === 'BANK' ? [BANK_CODE] : [CASH_CODE, BANK_CODE];
    const codeParam = where.param(codes);
    where.raw(`a."code" = ANY(${codeParam}::text[])`);

    // The true opening balance for a location: everything posted before the
    // window. Without this the first row of a filtered range would open at zero
    // and every closing balance after it would be wrong.
    const openingClauses = [`je2."factoryId" = je."factoryId"`, `a2."code" = ANY(${codeParam}::text[])`, `jl2."tenantId" = jl."tenantId"`];
    if (p.dateFrom) openingClauses.push(`je2."entryDate" < ${where.param(p.dateFrom)}::date`);
    else openingClauses.push('FALSE');

    const dayNet = `(COALESCE(SUM(jl."debitPaise"), 0) - COALESCE(SUM(jl."creditPaise"), 0))`;
    const priorInRange = `COALESCE(SUM(${dayNet}) OVER (PARTITION BY je."factoryId" ORDER BY je."entryDate" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)`;
    const opening = `(MAX(ob."openingPaise") + ${priorInRange})`;

    return {
      from: `
        journal_lines jl
        JOIN journal_entries je ON je.id = jl."journalEntryId"
        JOIN accounts a ON a.id = jl."accountId"
        JOIN factories f ON f.id = je."factoryId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jl2."debitPaise" - jl2."creditPaise"), 0) AS "openingPaise"
          FROM journal_lines jl2
          JOIN journal_entries je2 ON je2.id = jl2."journalEntryId"
          JOIN accounts a2 ON a2.id = jl2."accountId"
          WHERE ${openingClauses.join(' AND ')}
        ) ob ON TRUE`,
      select: `
        (je."factoryId"::text || ':' || je."entryDate"::text) AS "id",
        je."entryDate",
        f."name" AS "factoryName",
        ${opening} AS "openingPaise",
        COALESCE(SUM(jl."debitPaise"), 0) AS "cashInPaise",
        COALESCE(SUM(jl."creditPaise"), 0) AS "cashOutPaise",
        (${opening} + ${dayNet}) AS "closingPaise",
        COUNT(*)::int AS "entryCount"`,
      where,
      groupBy: 'je."factoryId", je."entryDate", f."name"',
      tieBreak: 'je."entryDate"',
      sortMap: {
        entryDate: 'je."entryDate"',
        factoryName: 'f."name"',
        cashInPaise: 'COALESCE(SUM(jl."debitPaise"), 0)',
        cashOutPaise: 'COALESCE(SUM(jl."creditPaise"), 0)',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "dayCount",
        COALESCE(SUM(_s."cashInPaise"), 0) AS "cashInPaise",
        COALESCE(SUM(_s."cashOutPaise"), 0) AS "cashOutPaise",
        COALESCE(SUM(_s."cashInPaise" - _s."cashOutPaise"), 0) AS "netPaise"`,
    };
  },
});

defineReport({
  id: 'day-book',
  category: 'finance',
  slug: 'day-book',
  name: 'Day Book',
  description: 'Every journal posting in date order, with the account and party it touched.',
  dateFieldLabel: 'Entry Date',
  limitations: [
    'Transaction No and Payment Mode are not shown: a journal entry records the source document type and id, not its ' +
      'number or the mode it settled in. The Reference Type column identifies what created each posting.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'partyId', 'referenceType', 'accountKey'],
  searchFields: ['Narration', 'Account', 'Party', 'Reference Type'],
  defaultSort: { by: 'entryDate', dir: 'desc' },
  columns: [
    date('entryDate', 'Date'),
    text('referenceType', 'Transaction Type'),
    text('narration', 'Description', { sortable: false }),
    code('accountCode', 'Account Code'),
    text('accountName', 'Account'),
    text('partyName', 'Party'),
    money('debitPaise', 'Debit', { total: true }),
    money('creditPaise', 'Credit', { total: true }),
    money('runningBalancePaise', 'Running Balance'),
    text('factoryName', 'Location'),
  ],
  summary: [
    metric('lineCount', 'Postings', 'int'),
    metric('entryCount', 'Journal Entries', 'int'),
    metric('debitPaise', 'Total Debit'),
    metric('creditPaise', 'Total Credit'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('jl."tenantId"');
    where.factoryScope('je."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('je."entryDate"', p.dateFrom, p.dateTo);
    where.eq('jl."partyId"', p.partyId);
    where.eq('je."referenceType"', p.referenceType);
    where.search(['je."narration"', 'a."name"', 'pt."name"', 'je."referenceType"'], p.search);
    if (p.accountKey && SystemAccounts[p.accountKey]) where.eq('a."code"', SystemAccounts[p.accountKey].code);

    return {
      from: `
        journal_lines jl
        JOIN journal_entries je ON je.id = jl."journalEntryId"
        JOIN accounts a ON a.id = jl."accountId"
        JOIN factories f ON f.id = je."factoryId"
        LEFT JOIN parties pt ON pt.id = jl."partyId"`,
      select: `
        jl.id AS "id",
        je."entryDate",
        je."referenceType",
        je."narration",
        a."code" AS "accountCode", a."name" AS "accountName",
        pt."name" AS "partyName",
        jl."debitPaise", jl."creditPaise",
        SUM(jl."debitPaise" - jl."creditPaise") OVER (
          PARTITION BY je."factoryId"
          ORDER BY je."entryDate", je."createdAt", jl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "runningBalancePaise",
        f."name" AS "factoryName"`,
      where,
      tieBreak: 'jl.id',
      sortMap: {
        entryDate: 'je."entryDate"',
        referenceType: 'je."referenceType"',
        accountCode: 'a."code"',
        accountName: 'a."name"',
        partyName: 'pt."name"',
        debitPaise: 'jl."debitPaise"',
        creditPaise: 'jl."creditPaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COUNT(DISTINCT je.id)::int AS "entryCount",
        COALESCE(SUM(jl."debitPaise"), 0) AS "debitPaise",
        COALESCE(SUM(jl."creditPaise"), 0) AS "creditPaise"`,
    };
  },
});
