const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../config/database');
const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, metric } = require('../lib/columns');
const { SqlWhere } = require('../lib/sqlWhere');
const { allocatedAmount, lotValue } = require('../lib/fragments');
const { GLOBAL_DEFAULTS } = require('../../inventory/ageing.service');

/**
 * Management summaries that cut across modules.
 *
 * Each figure here is the same figure its own module's report produces — sales
 * value is POSTED invoice totals, collection is POSTED allocations, dead stock
 * follows the configured ageing policy. Nothing is recomputed by a second rule.
 */

const DEAD_DAYS = `COALESCE(pr."deadStockDays", pc."deadStockDays", f."deadStockDays", ${GLOBAL_DEFAULTS.deadStockDays})`;

/** Percentage change, guarding the divide-by-zero that an empty prior period gives. */
const trend = (current, previous) => {
  if (!previous) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
};

/** Shifts a date window back by its own length, for a like-for-like comparison. */
const previousPeriod = (dateFrom, dateTo) => {
  if (!dateFrom || !dateTo) return null;
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  const spanMs = to.getTime() - from.getTime() + 86400000;
  return {
    dateFrom: new Date(from.getTime() - spanMs).toISOString().slice(0, 10),
    dateTo: new Date(to.getTime() - spanMs).toISOString().slice(0, 10),
  };
};

defineReport({
  id: 'business-summary',
  category: 'analytics',
  slug: 'business-summary',
  name: 'Business Summary',
  description: 'The headline numbers for the selected period, against the period before it.',
  kind: 'kpi',
  dateFieldLabel: 'Document Date',
  filters: ['dateFrom', 'dateTo', 'factoryId'],
  columns: [],
  summary: [
    metric('salesPaise', 'Total Sales'),
    metric('purchasePaise', 'Total Purchase'),
    metric('productionQty', 'Production Quantity', 'qty'),
    metric('dispatchCount', 'Dispatches', 'int'),
    metric('collectionPaise', 'Collection'),
    metric('outstandingPaise', 'Outstanding Receivable'),
    metric('expensePaise', 'Expenses'),
    metric('stockValuePaise', 'Stock Value'),
    metric('deadStockValuePaise', 'Dead Stock Value'),
  ],
  async compute({ params: p, tenantId, allowedFactoryIds }) {
    /** Runs one aggregate over a date window, with tenant and location scope applied. */
    const period = async ({ dateFrom, dateTo }) => {
      const where = new SqlWhere();
      const tenantParam = where.param(tenantId);
      const factory = (column) => {
        const clause = where.factoryScopeSql(column, allowedFactoryIds, p.factoryId);
        return clause ? ` AND ${clause}` : '';
      };
      const window = (column) => {
        const parts = [];
        if (dateFrom) parts.push(` AND ${column} >= ${where.param(dateFrom)}::date`);
        if (dateTo) parts.push(` AND ${column} <= ${where.param(dateTo)}::date`);
        return parts.join('');
      };

      const sql = `
        SELECT
          (SELECT COALESCE(SUM(si."totalPaise"), 0) FROM sales_invoices si
            WHERE si."tenantId" = ${tenantParam} AND si."status" = 'POSTED'${factory('si."factoryId"')}${window('si."invoiceDate"')}) AS "salesPaise",
          (SELECT COALESCE(SUM(pi."amountPaise"), 0) FROM purchase_invoices pi
            WHERE pi."tenantId" = ${tenantParam}${factory('pi."factoryId"')}${window('pi."invoiceDate"')}) AS "purchasePaise",
          (SELECT COALESCE(SUM(pe."goodQty"), 0) FROM production_entries pe
            WHERE pe."tenantId" = ${tenantParam} AND pe."status" = 'POSTED'${factory('pe."factoryId"')}${window('pe."productionDate"')}) AS "productionQty",
          (SELECT COUNT(*)::int FROM delivery_challans dc
            WHERE dc."tenantId" = ${tenantParam} AND dc."status" = 'DISPATCHED'${factory('dc."factoryId"')}${window('dc."dispatchDate"')}) AS "dispatchCount",
          (SELECT COALESCE(SUM(r."totalAmountPaise"), 0) FROM receipts r
            WHERE r."tenantId" = ${tenantParam} AND r."status" = 'POSTED'${factory('r."factoryId"')}${window('r."receiptDate"')}) AS "collectionPaise",
          (SELECT COALESCE(SUM(ex."amountPaise"), 0) FROM expenses ex
            WHERE ex."tenantId" = ${tenantParam} AND ex."status" = 'POSTED'${factory('ex."factoryId"')}${window('ex."expenseDate"')}) AS "expensePaise"`;

      const [row] = await sequelize.query(sql, { bind: where.bind, type: QueryTypes.SELECT });
      return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]));
    };

    /**
     * Balance-sheet figures are as-at-today, not period figures: what is
     * outstanding and what stock is on hand have no meaning "during" a window.
     */
    const asAtNow = async () => {
      const where = new SqlWhere();
      const tenantParam = where.param(tenantId);
      const factory = (column) => {
        const clause = where.factoryScopeSql(column, allowedFactoryIds, p.factoryId);
        return clause ? ` AND ${clause}` : '';
      };

      const sql = `
        SELECT
          (SELECT COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0)
             FROM sales_invoices si
             LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si.id')}) pay ON TRUE
            WHERE si."tenantId" = ${tenantParam} AND si."status" = 'POSTED'${factory('si."factoryId"')}
              AND (si."totalPaise" - pay."paidPaise") > 0) AS "outstandingPaise",
          (SELECT COALESCE(SUM(${lotValue('sl."qtyAvailable"', 'pr')}), 0)
             FROM stock_lots sl JOIN products pr ON pr.id = sl."productId"
            WHERE sl."tenantId" = ${tenantParam} AND sl."status" = 'AVAILABLE' AND sl."qtyAvailable" > 0${factory('sl."factoryId"')}) AS "stockValuePaise",
          (SELECT COALESCE(SUM(${lotValue('sl."qtyAvailable"', 'pr')}), 0)
             FROM stock_lots sl
             JOIN products pr ON pr.id = sl."productId"
             JOIN factories f ON f.id = sl."factoryId"
             LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
            WHERE sl."tenantId" = ${tenantParam} AND sl."status" = 'AVAILABLE' AND sl."qtyAvailable" > 0${factory('sl."factoryId"')}
              AND (CURRENT_DATE - sl."originDate")::int >= ${DEAD_DAYS}) AS "deadStockValuePaise"`;

      const [row] = await sequelize.query(sql, { bind: where.bind, type: QueryTypes.SELECT });
      return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]));
    };

    const [current, balances] = await Promise.all([period({ dateFrom: p.dateFrom, dateTo: p.dateTo }), asAtNow()]);

    const prior = previousPeriod(p.dateFrom, p.dateTo);
    const previous = prior ? await period(prior) : null;

    const trends = previous
      ? {
          salesPaise: trend(current.salesPaise, previous.salesPaise),
          purchasePaise: trend(current.purchasePaise, previous.purchasePaise),
          productionQty: trend(current.productionQty, previous.productionQty),
          dispatchCount: trend(current.dispatchCount, previous.dispatchCount),
          collectionPaise: trend(current.collectionPaise, previous.collectionPaise),
          expensePaise: trend(current.expensePaise, previous.expensePaise),
        }
      : null;

    return { ...current, ...balances, trends, comparedTo: prior };
  },
});

defineReport({
  id: 'location-performance',
  category: 'analytics',
  slug: 'location-performance',
  name: 'Location Performance',
  description: 'Every location side by side: what it sold, bought, made, dispatched, spent and is owed.',
  dateFieldLabel: 'Document Date',
  filters: ['dateFrom', 'dateTo', 'factoryId'],
  searchFields: ['Location Name', 'Location Code'],
  defaultSort: { by: 'salesPaise', dir: 'desc' },
  columns: [
    code('factoryCode', 'Location Code'),
    text('factoryName', 'Location'),
    money('salesPaise', 'Sales', { total: true }),
    money('purchasePaise', 'Purchase', { total: true }),
    qty('productionQty', 'Production'),
    int('dispatchCount', 'Dispatches'),
    money('expensePaise', 'Expenses', { total: true }),
    money('collectionPaise', 'Collection', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    money('stockValuePaise', 'Stock Value', { total: true }),
  ],
  summary: [
    metric('locationCount', 'Locations', 'int'),
    metric('salesPaise', 'Sales'),
    metric('purchasePaise', 'Purchase'),
    metric('expensePaise', 'Expenses'),
    metric('outstandingPaise', 'Outstanding'),
    metric('stockValuePaise', 'Stock Value'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('f."tenantId"');
    where.factoryScope('f."id"', allowedFactoryIds, p.factoryId);
    where.search(['f."name"', 'f."code"'], p.search);

    // Each figure is scoped to the same window inside its own LATERAL, which
    // keeps every bind parameter in FROM (see runner.js) and lets Postgres use
    // each table's own (factory, date) index instead of one giant outer join.
    const window = (column) => {
      const parts = [];
      if (p.dateFrom) parts.push(` AND ${column} >= ${where.param(p.dateFrom)}::date`);
      if (p.dateTo) parts.push(` AND ${column} <= ${where.param(p.dateTo)}::date`);
      return parts.join('');
    };

    return {
      from: `
        factories f
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(si."totalPaise"), 0) AS "salesPaise"
          FROM sales_invoices si
          WHERE si."factoryId" = f.id AND si."status" = 'POSTED'${window('si."invoiceDate"')}
        ) sal ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pi."amountPaise"), 0) AS "purchasePaise"
          FROM purchase_invoices pi
          WHERE pi."factoryId" = f.id${window('pi."invoiceDate"')}
        ) pur ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pe."goodQty"), 0) AS "productionQty"
          FROM production_entries pe
          WHERE pe."factoryId" = f.id AND pe."status" = 'POSTED'${window('pe."productionDate"')}
        ) prd ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS "dispatchCount"
          FROM delivery_challans dc
          WHERE dc."factoryId" = f.id AND dc."status" = 'DISPATCHED'${window('dc."dispatchDate"')}
        ) dis ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ex."amountPaise"), 0) AS "expensePaise"
          FROM expenses ex
          WHERE ex."factoryId" = f.id AND ex."status" = 'POSTED'${window('ex."expenseDate"')}
        ) exp ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(r."totalAmountPaise"), 0) AS "collectionPaise"
          FROM receipts r
          WHERE r."factoryId" = f.id AND r."status" = 'POSTED'${window('r."receiptDate"')}
        ) col ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(si2."totalPaise" - pay."paidPaise"), 0) AS "outstandingPaise"
          FROM sales_invoices si2
          LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si2.id')}) pay ON TRUE
          WHERE si2."factoryId" = f.id AND si2."status" = 'POSTED' AND (si2."totalPaise" - pay."paidPaise") > 0
        ) out ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(${lotValue('sl."qtyAvailable"', 'pr')}), 0) AS "stockValuePaise"
          FROM stock_lots sl JOIN products pr ON pr.id = sl."productId"
          WHERE sl."factoryId" = f.id AND sl."status" = 'AVAILABLE' AND sl."qtyAvailable" > 0
        ) stk ON TRUE`,
      select: `
        f.id AS "id",
        f."code" AS "factoryCode", f."name" AS "factoryName",
        sal."salesPaise", pur."purchasePaise", prd."productionQty", dis."dispatchCount",
        exp."expensePaise", col."collectionPaise", out."outstandingPaise", stk."stockValuePaise"`,
      where,
      tieBreak: 'f."name"',
      sortMap: {
        factoryCode: 'f."code"',
        factoryName: 'f."name"',
        salesPaise: 'sal."salesPaise"',
        purchasePaise: 'pur."purchasePaise"',
        productionQty: 'prd."productionQty"',
        dispatchCount: 'dis."dispatchCount"',
        expensePaise: 'exp."expensePaise"',
        collectionPaise: 'col."collectionPaise"',
        outstandingPaise: 'out."outstandingPaise"',
        stockValuePaise: 'stk."stockValuePaise"',
      },
      summarySelect: `
        COUNT(*)::int AS "locationCount",
        COALESCE(SUM(sal."salesPaise"), 0) AS "salesPaise",
        COALESCE(SUM(pur."purchasePaise"), 0) AS "purchasePaise",
        COALESCE(SUM(exp."expensePaise"), 0) AS "expensePaise",
        COALESCE(SUM(out."outstandingPaise"), 0) AS "outstandingPaise",
        COALESCE(SUM(stk."stockValuePaise"), 0) AS "stockValuePaise"`,
    };
  },
});

defineReport({
  id: 'product-performance',
  category: 'analytics',
  slug: 'product-performance',
  name: 'Product Performance',
  description: 'Per product: what came in from purchase and production, what went out as sales, and what is left.',
  dateFieldLabel: 'Document Date',
  limitations: [
    'Opening and closing stock are derived from the stock ledger, which is dated by when a movement was recorded rather ' +
      'than by the document\'s business date.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Name', 'Product Code'],
  defaultSort: { by: 'salesValuePaise', dir: 'desc' },
  columns: [
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    qty('openingStock', 'Opening Stock'),
    qty('purchaseQty', 'Purchase Qty'),
    qty('productionQty', 'Production Qty'),
    qty('salesQty', 'Sales Qty'),
    qty('closingStock', 'Closing Stock'),
    money('salesValuePaise', 'Sales Value', { total: true }),
    money('stockValuePaise', 'Stock Value', { total: true }),
    date('lastSaleDate', 'Last Sale'),
  ],
  summary: [
    metric('productCount', 'Products', 'int'),
    metric('salesQty', 'Sales Quantity', 'qty'),
    metric('salesValuePaise', 'Sales Value'),
    metric('closingStock', 'Closing Stock', 'qty'),
    metric('stockValuePaise', 'Stock Value'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pr."tenantId"');
    where.eq('pr.id', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."name"', 'pr."code"'], p.search);

    const factory = (column) => {
      const clause = where.factoryScopeSql(column, allowedFactoryIds, p.factoryId);
      return clause ? ` AND ${clause}` : '';
    };
    const window = (column) => {
      const parts = [];
      if (p.dateFrom) parts.push(` AND ${column} >= ${where.param(p.dateFrom)}::date`);
      if (p.dateTo) parts.push(` AND ${column} <= ${where.param(p.dateTo)}::date`);
      return parts.join('');
    };
    const beforeWindow = p.dateFrom ? `sle."createdAt" < ${where.param(p.dateFrom)}::timestamptz` : 'FALSE';
    const ledgerWindow = [];
    if (p.dateFrom) ledgerWindow.push(` AND sle2."createdAt" >= ${where.param(p.dateFrom)}::timestamptz`);
    if (p.dateTo) ledgerWindow.push(` AND sle2."createdAt" < (${where.param(p.dateTo)}::date + INTERVAL '1 day')`);

    return {
      from: `
        products pr
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(CASE WHEN sle."direction" = 'IN' THEN sle.quantity ELSE -sle.quantity END) FILTER (WHERE ${beforeWindow}), 0) AS "openingStock"
          FROM stock_ledger_entries sle
          WHERE sle."productId" = pr.id${factory('sle."factoryId"')}
        ) opn ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(CASE WHEN sle2."direction" = 'IN' THEN sle2.quantity ELSE -sle2.quantity END), 0) AS "netMovement"
          FROM stock_ledger_entries sle2
          WHERE sle2."productId" = pr.id${factory('sle2."factoryId"')}${ledgerWindow.join('')}
        ) mov ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(grl."receivedQty"), 0) AS "purchaseQty"
          FROM goods_receipt_lines grl
          JOIN goods_receipts gr ON gr.id = grl."goodsReceiptId"
          WHERE grl."productId" = pr.id AND gr."status" = 'POSTED'${factory('gr."factoryId"')}${window('gr."receiptDate"')}
        ) pur ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pe."goodQty"), 0) AS "productionQty"
          FROM production_entries pe
          WHERE pe."productId" = pr.id AND pe."status" = 'POSTED'${factory('pe."factoryId"')}${window('pe."productionDate"')}
        ) prd ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(sil.quantity), 0) AS "salesQty",
            COALESCE(SUM(sil."lineTotalPaise"), 0) AS "salesValuePaise",
            MAX(si."invoiceDate") AS "lastSaleDate"
          FROM sales_invoice_lines sil
          JOIN sales_invoices si ON si.id = sil."salesInvoiceId"
          WHERE sil."productId" = pr.id AND si."status" = 'POSTED'${factory('si."factoryId"')}${window('si."invoiceDate"')}
        ) sal ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(sl."qtyAvailable"), 0) AS "onHandQty"
          FROM stock_lots sl
          WHERE sl."productId" = pr.id AND sl."status" = 'AVAILABLE'${factory('sl."factoryId"')}
        ) stk ON TRUE`,
      select: `
        pr.id AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        opn."openingStock",
        pur."purchaseQty", prd."productionQty",
        sal."salesQty", sal."salesValuePaise", sal."lastSaleDate",
        (opn."openingStock" + mov."netMovement") AS "closingStock",
        ${lotValue('stk."onHandQty"', 'pr')} AS "stockValuePaise"`,
      where,
      tieBreak: 'pr."name"',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        openingStock: 'opn."openingStock"',
        purchaseQty: 'pur."purchaseQty"',
        productionQty: 'prd."productionQty"',
        salesQty: 'sal."salesQty"',
        salesValuePaise: 'sal."salesValuePaise"',
        closingStock: '(opn."openingStock" + mov."netMovement")',
        stockValuePaise: lotValue('stk."onHandQty"', 'pr'),
        lastSaleDate: 'sal."lastSaleDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "productCount",
        COALESCE(SUM(sal."salesQty"), 0) AS "salesQty",
        COALESCE(SUM(sal."salesValuePaise"), 0) AS "salesValuePaise",
        COALESCE(SUM(opn."openingStock" + mov."netMovement"), 0) AS "closingStock",
        COALESCE(SUM(${lotValue('stk."onHandQty"', 'pr')}), 0) AS "stockValuePaise"`,
    };
  },
});
