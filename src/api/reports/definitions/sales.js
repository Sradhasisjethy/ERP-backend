const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');
const { allocatedAmount, paymentStatusExpr } = require('../lib/fragments');

/**
 * Sales reports, all sourced from POSTED sales invoices and their lines — the
 * same rows invoicing.service.js writes, never a parallel summary table
 * (§23: the report and the transaction must agree by construction).
 *
 * Two columns the brief asks for do not exist in this schema and are therefore
 * absent rather than faked, and each report says so in `limitations`:
 *   - Sales Reference: parties has a SALES_REF type, but no sales document
 *     carries a salesRefPartyId, so sales cannot be attributed to a reference.
 *   - Discount: no sales document or line has a discount field.
 */

const LIMITATIONS = [
  'Sales Reference is not shown: no sales document carries a sales-reference party, so sales cannot be attributed to one.',
  'Discount is not shown: sales invoices and their lines hold no discount field.',
];

/** Paid-to-date on an invoice, as one LATERAL so it can be filtered and summed. */
const PAID_LATERAL = `LEFT JOIN LATERAL (${allocatedAmount('SALES', 'si.id')}) pay ON TRUE`;

/** Restricts to invoices containing a given product / product category. */
const lineExists = (where, { productId, categoryId }) => {
  if (!productId && !categoryId) return;
  const clauses = ['sil."salesInvoiceId" = si.id'];
  if (productId) clauses.push(`sil."productId" = ${where.param(productId)}`);
  if (categoryId) clauses.push(`pr."categoryId" = ${where.param(categoryId)}`);
  where.raw(`EXISTS (SELECT 1 FROM sales_invoice_lines sil JOIN products pr ON pr.id = sil."productId" WHERE ${clauses.join(' AND ')})`);
};

defineReport({
  id: 'sales-summary',
  category: 'sales',
  slug: 'summary',
  name: 'Sales Summary',
  description: 'One row per sales invoice, with tax, collection and what is still outstanding.',
  dateFieldLabel: 'Invoice Date',
  limitations: LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'productId', 'categoryId', 'status', 'paymentStatus'],
  searchFields: ['Invoice No', 'Customer Name', 'Customer Code'],
  defaultSort: { by: 'invoiceDate', dir: 'desc' },
  columns: [
    code('invoiceNumber', 'Invoice No'),
    date('invoiceDate', 'Invoice Date'),
    code('customerCode', 'Customer Code'),
    text('customerName', 'Customer'),
    text('factoryName', 'Location'),
    int('itemCount', 'Items'),
    qty('quantity', 'Quantity'),
    money('grossPaise', 'Gross Amount', { total: true }),
    money('taxPaise', 'Tax', { total: true }),
    money('roundOffPaise', 'Round Off', { hidden: true }),
    money('netPaise', 'Net Amount', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
    status('paymentStatus', 'Payment Status'),
    status('status', 'Invoice Status'),
  ],
  summary: [
    metric('invoiceCount', 'Invoices', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('grossPaise', 'Gross Sales'),
    metric('taxPaise', 'Tax'),
    metric('netPaise', 'Net Sales'),
    metric('paidPaise', 'Collected'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('si."customerPartyId"', p.customerId);
    where.token('si."status"', p.status);
    where.search(['si."invoiceNumber"', 'c."name"', 'c."code"'], p.search);
    lineExists(where, p);
    if (p.paymentStatus) {
      where.raw(`${paymentStatusExpr('si."totalPaise"', 'pay."paidPaise"')} = ${where.param(p.paymentStatus)}`);
    }

    return {
      from: `
        sales_invoices si
        JOIN parties c ON c.id = si."customerPartyId"
        JOIN factories f ON f.id = si."factoryId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS "itemCount", COALESCE(SUM(l.quantity), 0) AS quantity
          FROM sales_invoice_lines l WHERE l."salesInvoiceId" = si.id
        ) agg ON TRUE
        ${PAID_LATERAL}`,
      select: `
        si.id AS "id",
        si."invoiceNumber", si."invoiceDate",
        c."code" AS "customerCode", c."name" AS "customerName",
        f."name" AS "factoryName",
        agg."itemCount", agg.quantity,
        si."subtotalPaise" AS "grossPaise",
        (si."cgstPaise" + si."sgstPaise" + si."igstPaise") AS "taxPaise",
        si."roundOffPaise",
        si."totalPaise" AS "netPaise",
        pay."paidPaise",
        (si."totalPaise" - pay."paidPaise") AS "outstandingPaise",
        ${paymentStatusExpr('si."totalPaise"', 'pay."paidPaise"')} AS "paymentStatus",
        si."status"`,
      where,
      tieBreak: 'si.id',
      sortMap: {
        invoiceNumber: 'si."invoiceNumber"',
        invoiceDate: 'si."invoiceDate"',
        customerName: 'c."name"',
        customerCode: 'c."code"',
        factoryName: 'f."name"',
        quantity: 'agg.quantity',
        grossPaise: 'si."subtotalPaise"',
        taxPaise: '(si."cgstPaise" + si."sgstPaise" + si."igstPaise")',
        netPaise: 'si."totalPaise"',
        paidPaise: 'pay."paidPaise"',
        outstandingPaise: '(si."totalPaise" - pay."paidPaise")',
        itemCount: 'agg."itemCount"',
      },
      summarySelect: `
        COUNT(*)::int AS "invoiceCount",
        COALESCE(SUM(agg.quantity), 0) AS "quantity",
        COALESCE(SUM(si."subtotalPaise"), 0) AS "grossPaise",
        COALESCE(SUM(si."cgstPaise" + si."sgstPaise" + si."igstPaise"), 0) AS "taxPaise",
        COALESCE(SUM(si."totalPaise"), 0) AS "netPaise",
        COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

defineReport({
  id: 'sales-detail',
  category: 'sales',
  slug: 'detail',
  name: 'Sales Detail',
  description: 'One row per invoice line — what was sold, at what rate, with the tax charged on it.',
  dateFieldLabel: 'Invoice Date',
  limitations: LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'productId', 'categoryId', 'status'],
  searchFields: ['Invoice No', 'Customer Name', 'Product Name', 'Product Code'],
  defaultSort: { by: 'invoiceDate', dir: 'desc' },
  columns: [
    code('invoiceNumber', 'Invoice No'),
    date('invoiceDate', 'Invoice Date'),
    text('customerName', 'Customer'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    qty('quantity', 'Quantity'),
    money('ratePaise', 'Rate'),
    money('taxableAmountPaise', 'Taxable', { total: true }),
    money('taxPaise', 'Tax', { total: true }),
    money('lineTotalPaise', 'Amount', { total: true }),
    text('factoryName', 'Location'),
  ],
  summary: [
    metric('lineCount', 'Lines', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('taxableAmountPaise', 'Taxable Value'),
    metric('taxPaise', 'Tax'),
    metric('lineTotalPaise', 'Line Total'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('si."customerPartyId"', p.customerId);
    where.token('si."status"', p.status);
    where.eq('sil."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.search(['si."invoiceNumber"', 'c."name"', 'pr."name"', 'pr."code"'], p.search);

    return {
      from: `
        sales_invoice_lines sil
        JOIN sales_invoices si ON si.id = sil."salesInvoiceId"
        JOIN parties c ON c.id = si."customerPartyId"
        JOIN factories f ON f.id = si."factoryId"
        JOIN products pr ON pr.id = sil."productId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"`,
      select: `
        sil.id AS "id",
        si."invoiceNumber", si."invoiceDate",
        c."name" AS "customerName",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        sil.quantity, sil."ratePaise", sil."taxableAmountPaise",
        (sil."cgstPaise" + sil."sgstPaise" + sil."igstPaise") AS "taxPaise",
        sil."lineTotalPaise",
        f."name" AS "factoryName"`,
      where,
      tieBreak: 'sil.id',
      sortMap: {
        invoiceNumber: 'si."invoiceNumber"',
        invoiceDate: 'si."invoiceDate"',
        customerName: 'c."name"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        quantity: 'sil.quantity',
        ratePaise: 'sil."ratePaise"',
        taxableAmountPaise: 'sil."taxableAmountPaise"',
        lineTotalPaise: 'sil."lineTotalPaise"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COALESCE(SUM(sil.quantity), 0) AS "quantity",
        COALESCE(SUM(sil."taxableAmountPaise"), 0) AS "taxableAmountPaise",
        COALESCE(SUM(sil."cgstPaise" + sil."sgstPaise" + sil."igstPaise"), 0) AS "taxPaise",
        COALESCE(SUM(sil."lineTotalPaise"), 0) AS "lineTotalPaise"`,
    };
  },
});

defineReport({
  id: 'sales-by-customer',
  category: 'sales',
  slug: 'by-customer',
  name: 'Sales by Customer',
  description: 'Order and invoice activity per customer, with collection and outstanding.',
  dateFieldLabel: 'Invoice Date',
  limitations: LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId'],
  searchFields: ['Customer Name', 'Customer Code'],
  defaultSort: { by: 'netPaise', dir: 'desc' },
  columns: [
    code('customerCode', 'Customer Code'),
    text('customerName', 'Customer'),
    int('orderCount', 'Orders'),
    int('invoiceCount', 'Invoices'),
    qty('quantity', 'Quantity'),
    money('grossPaise', 'Gross Sales', { total: true }),
    money('taxPaise', 'Tax', { total: true }),
    money('netPaise', 'Net Sales', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
  ],
  summary: [
    metric('customerCount', 'Customers', 'int'),
    metric('invoiceCount', 'Invoices', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('netPaise', 'Net Sales'),
    metric('paidPaise', 'Collected'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('si."customerPartyId"', p.customerId);
    where.token('si."status"', 'POSTED');
    where.search(['c."name"', 'c."code"'], p.search);

    // The order count is scoped by the same date window and factory scope as the
    // invoices, so the two columns describe the same period rather than one
    // being lifetime-to-date. It lives in a LATERAL rather than a select-list
    // subquery so its bind parameters survive into the count query (see runner).
    const orderWhere = ['so."customerPartyId" = c.id', 'so."tenantId" = c."tenantId"', `so.status <> 'CANCELLED'`];
    if (p.dateFrom) orderWhere.push(`so."orderDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) orderWhere.push(`so."orderDate" <= ${where.param(p.dateTo)}::date`);
    if (allowedFactoryIds !== null || p.factoryId) {
      const ids = p.factoryId ? [p.factoryId] : allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000'];
      orderWhere.push(`so."factoryId" = ANY(${where.param(ids)}::uuid[])`);
    }

    return {
      from: `
        sales_invoices si
        JOIN parties c ON c.id = si."customerPartyId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(l.quantity), 0) AS quantity
          FROM sales_invoice_lines l WHERE l."salesInvoiceId" = si.id
        ) agg ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS "orderCount" FROM sales_orders so WHERE ${orderWhere.join(' AND ')}
        ) ord ON TRUE
        ${PAID_LATERAL}`,
      select: `
        c.id AS "id",
        c."code" AS "customerCode", c."name" AS "customerName",
        MAX(ord."orderCount")::int AS "orderCount",
        COUNT(si.id)::int AS "invoiceCount",
        COALESCE(SUM(agg.quantity), 0) AS "quantity",
        COALESCE(SUM(si."subtotalPaise"), 0) AS "grossPaise",
        COALESCE(SUM(si."cgstPaise" + si."sgstPaise" + si."igstPaise"), 0) AS "taxPaise",
        COALESCE(SUM(si."totalPaise"), 0) AS "netPaise",
        COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0) AS "outstandingPaise"`,
      where,
      groupBy: 'c.id, c."code", c."name", c."tenantId"',
      tieBreak: 'c."name"',
      sortMap: {
        customerCode: 'c."code"',
        customerName: 'c."name"',
        invoiceCount: 'COUNT(si.id)',
        quantity: 'COALESCE(SUM(agg.quantity), 0)',
        grossPaise: 'COALESCE(SUM(si."subtotalPaise"), 0)',
        netPaise: 'COALESCE(SUM(si."totalPaise"), 0)',
        paidPaise: 'COALESCE(SUM(pay."paidPaise"), 0)',
        outstandingPaise: 'COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0)',
      },
      // Grouped reports total the grouped rows, not the raw table, so the tiles
      // agree with what the reader can add up on screen.
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "customerCount",
        COALESCE(SUM(_s."invoiceCount"), 0)::int AS "invoiceCount",
        COALESCE(SUM(_s.quantity), 0) AS "quantity",
        COALESCE(SUM(_s."netPaise"), 0) AS "netPaise",
        COALESCE(SUM(_s."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise"`,
    };
  },
});

defineReport({
  id: 'sales-by-product',
  category: 'sales',
  slug: 'by-product',
  name: 'Sales by Product',
  description: 'What sold, how much of it, and at what average realised rate.',
  dateFieldLabel: 'Invoice Date',
  limitations: LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'customerId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Name', 'Product Code'],
  defaultSort: { by: 'netPaise', dir: 'desc' },
  columns: [
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    qty('quantitySold', 'Quantity Sold'),
    money('avgRatePaise', 'Average Rate'),
    money('grossPaise', 'Gross Sales', { total: true }),
    money('taxPaise', 'Tax', { total: true }),
    money('netPaise', 'Net Sales', { total: true }),
  ],
  summary: [
    metric('productCount', 'Products', 'int'),
    metric('quantitySold', 'Quantity Sold', 'qty'),
    metric('grossPaise', 'Gross Sales'),
    metric('taxPaise', 'Tax'),
    metric('netPaise', 'Net Sales'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.eq('si."customerPartyId"', p.customerId);
    where.token('si."status"', 'POSTED');
    where.eq('sil."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."name"', 'pr."code"'], p.search);

    return {
      from: `
        sales_invoice_lines sil
        JOIN sales_invoices si ON si.id = sil."salesInvoiceId"
        JOIN products pr ON pr.id = sil."productId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"`,
      select: `
        pr.id AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        COALESCE(SUM(sil.quantity), 0) AS "quantitySold",
        -- Realised rate, not list rate: total taxable value over total quantity,
        -- so a big line weighs more than a small one.
        CASE WHEN COALESCE(SUM(sil.quantity), 0) = 0 THEN 0
             ELSE ROUND(SUM(sil."taxableAmountPaise") / SUM(sil.quantity)) END AS "avgRatePaise",
        COALESCE(SUM(sil."taxableAmountPaise"), 0) AS "grossPaise",
        COALESCE(SUM(sil."cgstPaise" + sil."sgstPaise" + sil."igstPaise"), 0) AS "taxPaise",
        COALESCE(SUM(sil."lineTotalPaise"), 0) AS "netPaise"`,
      where,
      groupBy: 'pr.id, pr."code", pr."name", pc."name", u."code"',
      tieBreak: 'pr."name"',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        quantitySold: 'COALESCE(SUM(sil.quantity), 0)',
        grossPaise: 'COALESCE(SUM(sil."taxableAmountPaise"), 0)',
        netPaise: 'COALESCE(SUM(sil."lineTotalPaise"), 0)',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "productCount",
        COALESCE(SUM(_s."quantitySold"), 0) AS "quantitySold",
        COALESCE(SUM(_s."grossPaise"), 0) AS "grossPaise",
        COALESCE(SUM(_s."taxPaise"), 0) AS "taxPaise",
        COALESCE(SUM(_s."netPaise"), 0) AS "netPaise"`,
    };
  },
});

defineReport({
  id: 'sales-by-location',
  category: 'sales',
  slug: 'by-location',
  name: 'Sales by Location',
  description: 'Order and invoice activity per factory, with collection and outstanding.',
  dateFieldLabel: 'Invoice Date',
  limitations: LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId'],
  searchFields: ['Location Name', 'Location Code'],
  defaultSort: { by: 'netPaise', dir: 'desc' },
  columns: [
    code('factoryCode', 'Location Code'),
    text('factoryName', 'Location'),
    int('orderCount', 'Orders'),
    int('invoiceCount', 'Invoices'),
    qty('quantity', 'Quantity'),
    money('grossPaise', 'Gross Sales', { total: true }),
    money('netPaise', 'Net Sales', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
  ],
  summary: [
    metric('locationCount', 'Locations', 'int'),
    metric('invoiceCount', 'Invoices', 'int'),
    metric('netPaise', 'Net Sales'),
    metric('paidPaise', 'Collected'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('si."tenantId"');
    where.factoryScope('si."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('si."invoiceDate"', p.dateFrom, p.dateTo);
    where.token('si."status"', 'POSTED');
    where.search(['f."name"', 'f."code"'], p.search);

    const orderWhere = ['so."factoryId" = f.id', 'so."tenantId" = f."tenantId"', `so.status <> 'CANCELLED'`];
    if (p.dateFrom) orderWhere.push(`so."orderDate" >= ${where.param(p.dateFrom)}::date`);
    if (p.dateTo) orderWhere.push(`so."orderDate" <= ${where.param(p.dateTo)}::date`);

    return {
      from: `
        sales_invoices si
        JOIN factories f ON f.id = si."factoryId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(l.quantity), 0) AS quantity
          FROM sales_invoice_lines l WHERE l."salesInvoiceId" = si.id
        ) agg ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS "orderCount" FROM sales_orders so WHERE ${orderWhere.join(' AND ')}
        ) ord ON TRUE
        ${PAID_LATERAL}`,
      select: `
        f.id AS "id",
        f."code" AS "factoryCode", f."name" AS "factoryName",
        MAX(ord."orderCount")::int AS "orderCount",
        COUNT(si.id)::int AS "invoiceCount",
        COALESCE(SUM(agg.quantity), 0) AS "quantity",
        COALESCE(SUM(si."subtotalPaise"), 0) AS "grossPaise",
        COALESCE(SUM(si."totalPaise"), 0) AS "netPaise",
        COALESCE(SUM(pay."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0) AS "outstandingPaise"`,
      where,
      groupBy: 'f.id, f."code", f."name", f."tenantId"',
      tieBreak: 'f."name"',
      sortMap: {
        factoryCode: 'f."code"',
        factoryName: 'f."name"',
        invoiceCount: 'COUNT(si.id)',
        quantity: 'COALESCE(SUM(agg.quantity), 0)',
        grossPaise: 'COALESCE(SUM(si."subtotalPaise"), 0)',
        netPaise: 'COALESCE(SUM(si."totalPaise"), 0)',
        paidPaise: 'COALESCE(SUM(pay."paidPaise"), 0)',
        outstandingPaise: 'COALESCE(SUM(si."totalPaise" - pay."paidPaise"), 0)',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "locationCount",
        COALESCE(SUM(_s."invoiceCount"), 0)::int AS "invoiceCount",
        COALESCE(SUM(_s."netPaise"), 0) AS "netPaise",
        COALESCE(SUM(_s."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise"`,
    };
  },
});
