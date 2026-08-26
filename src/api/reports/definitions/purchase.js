const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');
const { allocatedAmount, paymentStatusExpr, daysOutstanding } = require('../lib/fragments');

/**
 * Purchase reports.
 *
 * Value comes from purchase invoices (the document that creates the payable);
 * quantity comes from the goods receipt those invoices are raised against,
 * which is where line detail actually lives. Paid-to-date is derived from
 * POSTED allocations by the same rule the payment service enforces, rather
 * than read from the denormalised `paymentStatus` column, so the report and
 * the ledger cannot disagree.
 */

const TAX_LIMITATION =
  'Gross / Discount / Tax are not split out: a purchase invoice in this schema carries a single amountPaise, with no ' +
  'taxable-value, tax or discount breakdown to report.';

const PAID_LATERAL = `LEFT JOIN LATERAL (${allocatedAmount('PURCHASE', 'pi.id')}) pay ON TRUE`;

const GRN_AGGREGATE = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS "itemCount", COALESCE(SUM(grl."receivedQty"), 0) AS quantity
    FROM goods_receipt_lines grl WHERE grl."goodsReceiptId" = pi."goodsReceiptId"
  ) agg ON TRUE`;

defineReport({
  id: 'purchase-summary',
  category: 'purchase',
  slug: 'summary',
  name: 'Purchase Summary',
  description: 'One row per purchase invoice, with what has been paid against it and what is still owed.',
  dateFieldLabel: 'Invoice Date',
  limitations: [TAX_LIMITATION],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId', 'paymentStatus'],
  searchFields: ['Vendor Invoice No', 'GRN No', 'Vendor Name', 'Vendor Code'],
  defaultSort: { by: 'invoiceDate', dir: 'desc' },
  columns: [
    code('vendorInvoiceNumber', 'Purchase No'),
    date('invoiceDate', 'Purchase Date'),
    code('vendorCode', 'Vendor Code'),
    text('vendorName', 'Vendor'),
    text('factoryName', 'Location'),
    code('grnNumber', 'GRN No'),
    int('itemCount', 'Items'),
    qty('quantity', 'Quantity'),
    money('amountPaise', 'Net Amount', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    date('dueDate', 'Due Date'),
    int('daysOutstanding', 'Days Outstanding'),
    status('paymentStatus', 'Payment Status'),
  ],
  summary: [
    metric('invoiceCount', 'Purchases', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('amountPaise', 'Net Purchase'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    // A cancelled vendor bill is not a payable. `purchase_invoices` gained a
    // status only when cancellation was implemented, so every query here had
    // been written without one — leaving a reversed invoice showing as
    // outstanding on the payables and purchase reports.
    const where = openWhere('pi."tenantId"');
    where.raw(`pi."status" = 'POSTED'`);
    where.factoryScope('pi."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('pi."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('pi."vendorPartyId"', p.vendorId);
    where.search(['pi."vendorInvoiceNumber"', 'gr."grnNumber"', 'v."name"', 'v."code"'], p.search);
    if (p.paymentStatus) {
      where.raw(`${paymentStatusExpr('pi."amountPaise"', 'pay."paidPaise"')} = ${where.param(p.paymentStatus)}`);
    }

    const dueDays = daysOutstanding('COALESCE(pi."dueDate", pi."invoiceDate")');

    return {
      from: `
        purchase_invoices pi
        JOIN parties v ON v.id = pi."vendorPartyId"
        JOIN factories f ON f.id = pi."factoryId"
        LEFT JOIN goods_receipts gr ON gr.id = pi."goodsReceiptId"
        ${GRN_AGGREGATE}
        ${PAID_LATERAL}`,
      select: `
        pi.id AS "id",
        pi."vendorInvoiceNumber", pi."invoiceDate",
        v."code" AS "vendorCode", v."name" AS "vendorName",
        f."name" AS "factoryName",
        gr."grnNumber",
        agg."itemCount", agg.quantity,
        pi."amountPaise",
        pay."paidPaise",
        (pi."amountPaise" - pay."paidPaise") AS "outstandingPaise",
        pi."dueDate",
        CASE WHEN pay."paidPaise" >= pi."amountPaise" THEN 0 ELSE ${dueDays} END AS "daysOutstanding",
        ${paymentStatusExpr('pi."amountPaise"', 'pay."paidPaise"')} AS "paymentStatus"`,
      where,
      tieBreak: 'pi.id',
      sortMap: {
        vendorInvoiceNumber: 'pi."vendorInvoiceNumber"',
        invoiceDate: 'pi."invoiceDate"',
        vendorName: 'v."name"',
        vendorCode: 'v."code"',
        factoryName: 'f."name"',
        grnNumber: 'gr."grnNumber"',
        quantity: 'agg.quantity',
        amountPaise: 'pi."amountPaise"',
        paidPaise: 'pay."paidPaise"',
        outstandingPaise: '(pi."amountPaise" - pay."paidPaise")',
        dueDate: 'pi."dueDate"',
        daysOutstanding: dueDays,
      },
      summarySelect: `
        COUNT(*)::int AS "invoiceCount",
        COALESCE(SUM(agg.quantity), 0) AS "quantity",
        COALESCE(SUM(pi."amountPaise"), 0) AS "amountPaise",
        COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(pi."amountPaise" - pay."paidPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

defineReport({
  id: 'purchase-detail',
  category: 'purchase',
  slug: 'detail',
  name: 'Purchase Detail',
  description: 'One row per goods-receipt line — what was received, at what rate.',
  dateFieldLabel: 'Receipt Date',
  limitations: [TAX_LIMITATION],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId', 'productId', 'categoryId', 'status'],
  searchFields: ['GRN No', 'Vendor Name', 'Product Name', 'Product Code'],
  defaultSort: { by: 'receiptDate', dir: 'desc' },
  columns: [
    code('grnNumber', 'Purchase No'),
    date('receiptDate', 'Purchase Date'),
    text('vendorName', 'Vendor'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    qty('receivedQty', 'Quantity'),
    money('ratePaise', 'Rate'),
    money('amountPaise', 'Amount', { total: true }),
    text('factoryName', 'Location'),
    status('status', 'Status'),
  ],
  summary: [
    metric('lineCount', 'Lines', 'int'),
    metric('receivedQty', 'Quantity', 'qty'),
    metric('amountPaise', 'Amount'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('gr."tenantId"');
    where.factoryScope('gr."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('gr."receiptDate"', p.dateFrom, p.dateTo);
    where.eq('gr."vendorPartyId"', p.vendorId);
    where.token('gr."status"', p.status || 'POSTED');
    where.eq('grl."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.search(['gr."grnNumber"', 'v."name"', 'pr."name"', 'pr."code"'], p.search);

    return {
      from: `
        goods_receipt_lines grl
        JOIN goods_receipts gr ON gr.id = grl."goodsReceiptId"
        JOIN parties v ON v.id = gr."vendorPartyId"
        JOIN factories f ON f.id = gr."factoryId"
        JOIN products pr ON pr.id = grl."productId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"`,
      select: `
        grl.id AS "id",
        gr."grnNumber", gr."receiptDate",
        v."name" AS "vendorName",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        grl."receivedQty", grl."ratePaise",
        ROUND(grl."receivedQty" * grl."ratePaise") AS "amountPaise",
        f."name" AS "factoryName",
        gr."status"`,
      where,
      tieBreak: 'grl.id',
      sortMap: {
        grnNumber: 'gr."grnNumber"',
        receiptDate: 'gr."receiptDate"',
        vendorName: 'v."name"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        receivedQty: 'grl."receivedQty"',
        ratePaise: 'grl."ratePaise"',
        amountPaise: 'ROUND(grl."receivedQty" * grl."ratePaise")',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COALESCE(SUM(grl."receivedQty"), 0) AS "receivedQty",
        COALESCE(SUM(ROUND(grl."receivedQty" * grl."ratePaise")), 0) AS "amountPaise"`,
    };
  },
});

defineReport({
  id: 'purchase-by-vendor',
  category: 'purchase',
  slug: 'by-vendor',
  name: 'Purchase by Vendor',
  description: 'Purchase volume and value per vendor, with what is still payable.',
  dateFieldLabel: 'Invoice Date',
  limitations: [TAX_LIMITATION],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId'],
  searchFields: ['Vendor Name', 'Vendor Code'],
  defaultSort: { by: 'amountPaise', dir: 'desc' },
  columns: [
    code('vendorCode', 'Vendor Code'),
    text('vendorName', 'Vendor'),
    int('purchaseCount', 'Purchases'),
    qty('quantity', 'Quantity'),
    money('amountPaise', 'Net Purchase', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    date('lastPurchaseDate', 'Last Purchase'),
  ],
  summary: [
    metric('vendorCount', 'Vendors', 'int'),
    metric('purchaseCount', 'Purchases', 'int'),
    metric('amountPaise', 'Net Purchase'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    // A cancelled vendor bill is not a payable. `purchase_invoices` gained a
    // status only when cancellation was implemented, so every query here had
    // been written without one — leaving a reversed invoice showing as
    // outstanding on the payables and purchase reports.
    const where = openWhere('pi."tenantId"');
    where.raw(`pi."status" = 'POSTED'`);
    where.factoryScope('pi."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('pi."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('pi."vendorPartyId"', p.vendorId);
    where.search(['v."name"', 'v."code"'], p.search);

    return {
      from: `
        purchase_invoices pi
        JOIN parties v ON v.id = pi."vendorPartyId"
        ${GRN_AGGREGATE}
        ${PAID_LATERAL}`,
      select: `
        v.id AS "id",
        v."code" AS "vendorCode", v."name" AS "vendorName",
        COUNT(pi.id)::int AS "purchaseCount",
        COALESCE(SUM(agg.quantity), 0) AS "quantity",
        COALESCE(SUM(pi."amountPaise"), 0) AS "amountPaise",
        COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(pi."amountPaise" - pay."paidPaise"), 0) AS "outstandingPaise",
        MAX(pi."invoiceDate") AS "lastPurchaseDate"`,
      where,
      groupBy: 'v.id, v."code", v."name"',
      tieBreak: 'v."name"',
      sortMap: {
        vendorCode: 'v."code"',
        vendorName: 'v."name"',
        purchaseCount: 'COUNT(pi.id)',
        quantity: 'COALESCE(SUM(agg.quantity), 0)',
        amountPaise: 'COALESCE(SUM(pi."amountPaise"), 0)',
        paidPaise: 'COALESCE(SUM(pay."paidPaise"), 0)',
        outstandingPaise: 'COALESCE(SUM(pi."amountPaise" - pay."paidPaise"), 0)',
        lastPurchaseDate: 'MAX(pi."invoiceDate")',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "vendorCount",
        COALESCE(SUM(_s."purchaseCount"), 0)::int AS "purchaseCount",
        COALESCE(SUM(_s."amountPaise"), 0) AS "amountPaise",
        COALESCE(SUM(_s."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

defineReport({
  id: 'purchase-by-product',
  category: 'purchase',
  slug: 'by-product',
  name: 'Purchase by Product',
  description: 'What was bought, how much of it, and at what average rate.',
  dateFieldLabel: 'Receipt Date',
  limitations: [TAX_LIMITATION],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'vendorId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Name', 'Product Code'],
  defaultSort: { by: 'amountPaise', dir: 'desc' },
  columns: [
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    qty('quantityPurchased', 'Quantity Purchased'),
    money('avgRatePaise', 'Average Rate'),
    money('amountPaise', 'Amount', { total: true }),
    date('lastPurchaseDate', 'Last Purchase'),
  ],
  summary: [
    metric('productCount', 'Products', 'int'),
    metric('quantityPurchased', 'Quantity', 'qty'),
    metric('amountPaise', 'Amount'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('gr."tenantId"');
    where.factoryScope('gr."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('gr."receiptDate"', p.dateFrom, p.dateTo);
    where.eq('gr."vendorPartyId"', p.vendorId);
    where.token('gr."status"', 'POSTED');
    where.eq('grl."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."name"', 'pr."code"'], p.search);

    return {
      from: `
        goods_receipt_lines grl
        JOIN goods_receipts gr ON gr.id = grl."goodsReceiptId"
        JOIN products pr ON pr.id = grl."productId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"`,
      select: `
        pr.id AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        COALESCE(SUM(grl."receivedQty"), 0) AS "quantityPurchased",
        CASE WHEN COALESCE(SUM(grl."receivedQty"), 0) = 0 THEN 0
             ELSE ROUND(SUM(grl."receivedQty" * grl."ratePaise") / SUM(grl."receivedQty")) END AS "avgRatePaise",
        COALESCE(SUM(ROUND(grl."receivedQty" * grl."ratePaise")), 0) AS "amountPaise",
        MAX(gr."receiptDate") AS "lastPurchaseDate"`,
      where,
      groupBy: 'pr.id, pr."code", pr."name", pc."name", u."code"',
      tieBreak: 'pr."name"',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        quantityPurchased: 'COALESCE(SUM(grl."receivedQty"), 0)',
        amountPaise: 'COALESCE(SUM(ROUND(grl."receivedQty" * grl."ratePaise")), 0)',
        lastPurchaseDate: 'MAX(gr."receiptDate")',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "productCount",
        COALESCE(SUM(_s."quantityPurchased"), 0) AS "quantityPurchased",
        COALESCE(SUM(_s."amountPaise"), 0) AS "amountPaise"`,
    };
  },
});
