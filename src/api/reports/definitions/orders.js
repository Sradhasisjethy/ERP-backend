const { defineReport } = require('../lib/registry');
const { VOCABULARY } = require('../lib/filters');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');

/**
 * Order-book reports.
 *
 * Fulfilment is measured from the order lines themselves — `orderedQty` less
 * `dispatchedQty`, which the dispatch flow maintains — rather than from a
 * separate status counter that could drift. "Reserved" comes from the ACTIVE
 * stock_reservations the sales flow creates against each line (BR-11).
 *
 * There is deliberately no "Produced Quantity" column: production entries link
 * to a production plan line, not to a sales order line, so output cannot be
 * attributed back to an order. `productionRequired` — the quantity the order
 * could not meet from stock, snapshotted at order entry (BR-12) — is shown
 * instead, because that figure genuinely exists.
 */

const PRODUCED_LIMITATION =
  'Produced Quantity per order is not shown: production entries are linked to a production plan line, not to a sales order line, ' +
  'so output cannot be attributed back to a specific order. "To Produce" (the shortfall snapshotted at order entry) is shown instead.';

const LINE_AGGREGATE = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS "itemCount",
      COALESCE(SUM(sol."orderedQty"), 0) AS "orderedQty",
      COALESCE(SUM(sol."dispatchedQty"), 0) AS "dispatchedQty",
      COALESCE(SUM(sol."productionRequired"), 0) AS "productionRequiredQty",
      COALESCE(SUM(GREATEST(sol."orderedQty" - sol."dispatchedQty", 0)), 0) AS "pendingQty"
    FROM sales_order_lines sol WHERE sol."salesOrderId" = so.id
  ) agg ON TRUE`;

const RESERVED_AGGREGATE = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sr.quantity), 0) AS "reservedQty"
    FROM stock_reservations sr
    JOIN sales_order_lines sol2 ON sol2.id = sr."referenceId"
    WHERE sr."referenceType" = 'SalesOrderLine' AND sr.status = 'ACTIVE' AND sol2."salesOrderId" = so.id
  ) res ON TRUE`;

const lineExists = (where, { productId, categoryId }) => {
  if (!productId && !categoryId) return;
  const clauses = ['sole."salesOrderId" = so.id'];
  if (productId) clauses.push(`sole."productId" = ${where.param(productId)}`);
  if (categoryId) clauses.push(`prx."categoryId" = ${where.param(categoryId)}`);
  where.raw(`EXISTS (SELECT 1 FROM sales_order_lines sole JOIN products prx ON prx.id = sole."productId" WHERE ${clauses.join(' AND ')})`);
};

defineReport({
  id: 'sales-order-book',
  filterOptions: { status: { options: VOCABULARY.salesOrderStatus } },
  category: 'orders',
  slug: 'sales-orders',
  name: 'Sales Order Report',
  description: 'The order book with fulfilment progress: ordered against reserved, dispatched and still pending.',
  dateFieldLabel: 'Order Date',
  limitations: [PRODUCED_LIMITATION, 'Sales Reference is not shown: sales orders carry no sales-reference party.'],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'productId', 'categoryId', 'status'],
  searchFields: ['Order No', 'Customer Name', 'Customer PO Reference'],
  defaultSort: { by: 'orderDate', dir: 'desc' },
  columns: [
    code('orderNumber', 'Order No'),
    date('orderDate', 'Order Date'),
    text('customerName', 'Customer'),
    text('factoryName', 'Location'),
    date('expectedDeliveryDate', 'Delivery Date'),
    code('poReferenceNumber', 'Customer PO', { hidden: true }),
    int('itemCount', 'Items'),
    qty('orderedQty', 'Ordered'),
    qty('reservedQty', 'Reserved'),
    qty('productionRequiredQty', 'To Produce'),
    qty('dispatchedQty', 'Dispatched'),
    qty('pendingQty', 'Pending'),
    money('totalAmountPaise', 'Order Value', { total: true }),
    status('status', 'Status'),
  ],
  summary: [
    metric('orderCount', 'Orders', 'int'),
    metric('orderedQty', 'Ordered', 'qty'),
    metric('dispatchedQty', 'Dispatched', 'qty'),
    metric('pendingQty', 'Pending', 'qty'),
    metric('totalAmountPaise', 'Order Value'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('so."tenantId"');
    where.factoryScope('so."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('so."orderDate"', p.dateFrom, p.dateTo);
    where.eq('so."customerPartyId"', p.customerId);
    where.token('so."status"', p.status);
    where.search(['so."orderNumber"', 'c."name"', 'c."code"', 'so."poReferenceNumber"'], p.search);
    lineExists(where, p);

    return {
      from: `
        sales_orders so
        JOIN parties c ON c.id = so."customerPartyId"
        JOIN factories f ON f.id = so."factoryId"
        ${LINE_AGGREGATE}
        ${RESERVED_AGGREGATE}`,
      select: `
        so.id AS "id",
        so."orderNumber", so."orderDate",
        c."name" AS "customerName",
        f."name" AS "factoryName",
        so."expectedDeliveryDate", so."poReferenceNumber",
        agg."itemCount", agg."orderedQty", res."reservedQty",
        agg."productionRequiredQty", agg."dispatchedQty", agg."pendingQty",
        so."totalAmountPaise",
        so."status"`,
      where,
      tieBreak: 'so.id',
      sortMap: {
        orderNumber: 'so."orderNumber"',
        orderDate: 'so."orderDate"',
        customerName: 'c."name"',
        factoryName: 'f."name"',
        expectedDeliveryDate: 'so."expectedDeliveryDate"',
        itemCount: 'agg."itemCount"',
        orderedQty: 'agg."orderedQty"',
        reservedQty: 'res."reservedQty"',
        dispatchedQty: 'agg."dispatchedQty"',
        pendingQty: 'agg."pendingQty"',
        totalAmountPaise: 'so."totalAmountPaise"',
      },
      summarySelect: `
        COUNT(*)::int AS "orderCount",
        COALESCE(SUM(agg."orderedQty"), 0) AS "orderedQty",
        COALESCE(SUM(agg."dispatchedQty"), 0) AS "dispatchedQty",
        COALESCE(SUM(agg."pendingQty"), 0) AS "pendingQty",
        COALESCE(SUM(so."totalAmountPaise"), 0) AS "totalAmountPaise"`,
    };
  },
});

defineReport({
  id: 'pending-orders',
  filterOptions: { status: { options: VOCABULARY.salesOrderStatus } },
  category: 'orders',
  slug: 'pending',
  name: 'Pending Order Report',
  description: 'Order lines still awaiting dispatch, oldest first, with overdue deliveries flagged.',
  dateFieldLabel: 'Order Date',
  limitations: [PRODUCED_LIMITATION],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'productId', 'categoryId', 'status', 'overdueOnly'],
  searchFields: ['Order No', 'Customer Name', 'Product Name'],
  defaultSort: { by: 'daysPending', dir: 'desc' },
  columns: [
    code('orderNumber', 'Order No'),
    date('orderDate', 'Order Date'),
    text('customerName', 'Customer'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    qty('orderedQty', 'Ordered'),
    qty('reservedQty', 'Reserved'),
    qty('productionRequiredQty', 'To Produce'),
    qty('dispatchedQty', 'Dispatched'),
    qty('pendingQty', 'Pending'),
    date('expectedDeliveryDate', 'Required By'),
    int('daysPending', 'Days Pending'),
    int('daysOverdue', 'Days Overdue'),
    text('factoryName', 'Location'),
    status('status', 'Status'),
  ],
  summary: [
    metric('lineCount', 'Pending Lines', 'int'),
    metric('orderCount', 'Orders', 'int'),
    metric('pendingQty', 'Pending Quantity', 'qty'),
    metric('overdueCount', 'Overdue Lines', 'int'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('so."tenantId"');
    where.factoryScope('so."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('so."orderDate"', p.dateFrom, p.dateTo);
    where.eq('so."customerPartyId"', p.customerId);
    where.eq('sol."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.search(['so."orderNumber"', 'c."name"', 'pr."name"', 'pr."code"'], p.search);

    // "Pending" means an open order with quantity still to go. A cancelled or
    // short-closed order has no outstanding obligation even if its arithmetic
    // still shows a gap, so those statuses are excluded rather than filtered
    // out by the reader.
    if (p.status) where.token('so."status"', p.status);
    else where.raw(`so."status" IN ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED')`);
    where.raw(`(sol."orderedQty" - sol."dispatchedQty") > 0`);
    if (p.overdueOnly === true || p.overdueOnly === 'true') {
      where.raw(`so."expectedDeliveryDate" IS NOT NULL AND so."expectedDeliveryDate" < CURRENT_DATE`);
    }

    const daysOverdue = `CASE WHEN so."expectedDeliveryDate" IS NULL THEN 0 ELSE GREATEST(0, (CURRENT_DATE - so."expectedDeliveryDate")::int) END`;

    return {
      from: `
        sales_order_lines sol
        JOIN sales_orders so ON so.id = sol."salesOrderId"
        JOIN parties c ON c.id = so."customerPartyId"
        JOIN factories f ON f.id = so."factoryId"
        JOIN products pr ON pr.id = sol."productId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(sr.quantity), 0) AS "reservedQty"
          FROM stock_reservations sr
          WHERE sr."referenceType" = 'SalesOrderLine' AND sr."referenceId" = sol.id AND sr.status = 'ACTIVE'
        ) res ON TRUE`,
      select: `
        sol.id AS "id",
        so."orderNumber", so."orderDate",
        c."name" AS "customerName",
        pr."code" AS "productCode", pr."name" AS "productName",
        sol."orderedQty", res."reservedQty", sol."productionRequired" AS "productionRequiredQty",
        sol."dispatchedQty",
        (sol."orderedQty" - sol."dispatchedQty") AS "pendingQty",
        so."expectedDeliveryDate",
        (CURRENT_DATE - so."orderDate")::int AS "daysPending",
        ${daysOverdue} AS "daysOverdue",
        f."name" AS "factoryName",
        so."status"`,
      where,
      tieBreak: 'sol.id',
      sortMap: {
        orderNumber: 'so."orderNumber"',
        orderDate: 'so."orderDate"',
        customerName: 'c."name"',
        productName: 'pr."name"',
        productCode: 'pr."code"',
        orderedQty: 'sol."orderedQty"',
        dispatchedQty: 'sol."dispatchedQty"',
        pendingQty: '(sol."orderedQty" - sol."dispatchedQty")',
        expectedDeliveryDate: 'so."expectedDeliveryDate"',
        daysPending: '(CURRENT_DATE - so."orderDate")',
        daysOverdue: daysOverdue,
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COUNT(DISTINCT so.id)::int AS "orderCount",
        COALESCE(SUM(sol."orderedQty" - sol."dispatchedQty"), 0) AS "pendingQty",
        COUNT(*) FILTER (WHERE so."expectedDeliveryDate" IS NOT NULL AND so."expectedDeliveryDate" < CURRENT_DATE)::int AS "overdueCount"`,
    };
  },
});
