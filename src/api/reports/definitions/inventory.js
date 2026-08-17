const { defineReport } = require('../lib/registry');
const { VOCABULARY } = require('../lib/filters');
const { text, code, date, qty, money, int, percent, status, metric } = require('../lib/columns');
const { lotValue } = require('../lib/fragments');

/**
 * Inventory reports.
 *
 * Everything here derives from the stock ledger, which is the system's record
 * of truth for movement — StockLedgerService.rebuildStockBalances reconstructs
 * lot balances from exactly these rows, so a report built the same way agrees
 * with the balances the application shows by construction rather than by luck.
 *
 * One honest caveat repeated on the movement-based reports: stock_ledger_entries
 * has no business-date column, only `createdAt` (the insert time). A production
 * entry can be backdated; the ledger row it writes cannot. Movement is
 * therefore dated by when it was recorded, and the reports say so.
 */

const LEDGER_DATE_NOTE =
  'Movement is dated by when it was recorded (the stock ledger has no separate business-date column), so a backdated ' +
  'document appears on the day it was entered.';

const NET_QTY = `CASE WHEN sle."direction" = 'IN' THEN sle.quantity ELSE -sle.quantity END`;

defineReport({
  id: 'inventory-current-stock',
  category: 'inventory',
  slug: 'current-stock',
  name: 'Current Stock',
  description: 'Stock position per product and location: opening, movement in and out, reserved and available.',
  dateFieldLabel: 'Movement Date',
  limitations: [LEDGER_DATE_NOTE],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'productType', 'stockStatus'],
  searchFields: ['Product Code', 'Product Name'],
  defaultSort: { by: 'productName', dir: 'asc' },
  columns: [
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    text('factoryName', 'Location'),
    qty('openingStock', 'Opening'),
    qty('stockIn', 'Stock In'),
    qty('stockOut', 'Stock Out'),
    qty('closingStock', 'Closing'),
    qty('reservedQty', 'Reserved'),
    qty('availableQty', 'Available'),
    qty('reorderLevel', 'Reorder Level', { hidden: true }),
    money('stockValuePaise', 'Stock Value', { total: true }),
    date('lastMovementDate', 'Last Movement'),
    status('stockStatus', 'Stock Status'),
  ],
  summary: [
    metric('skuCount', 'Stock Lines', 'int'),
    metric('closingStock', 'Closing Quantity', 'qty'),
    metric('reservedQty', 'Reserved', 'qty'),
    metric('availableQty', 'Available', 'qty'),
    metric('stockValuePaise', 'Stock Value'),
  ],
  build({ params: p, tenantId, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pr."tenantId"', 'f."tenantId"');

    // The row set is one line per (location, product) that has ever moved.
    // The date window does NOT filter that set — it splits each line's movement
    // into "before the window" (opening) and "inside it" (in/out). Filtering the
    // rows away instead would make the opening balance unknowable.
    //
    // The key list and the per-line aggregate both live in FROM rather than the
    // select list, so their bind parameters survive into the count query (see
    // runner.js) — and it avoids grouping the entire ledger table.
    const keyClauses = [`k0."tenantId" = ${where.param(tenantId)}`];
    const factoryClause = where.factoryScopeSql('k0."factoryId"', allowedFactoryIds, p.factoryId);
    if (factoryClause) keyClauses.push(factoryClause);
    if (p.productId) keyClauses.push(`k0."productId" = ${where.param(p.productId)}`);

    const windowClauses = [];
    if (p.dateFrom) windowClauses.push(`m."createdAt" >= ${where.param(p.dateFrom)}::timestamptz`);
    if (p.dateTo) windowClauses.push(`m."createdAt" < (${where.param(p.dateTo)}::date + INTERVAL '1 day')`);
    const inWindow = windowClauses.length ? windowClauses.join(' AND ') : 'TRUE';
    const beforeWindow = p.dateFrom ? `m."createdAt" < ${where.param(p.dateFrom)}::timestamptz` : 'FALSE';

    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."code"', 'pr."name"'], p.search);

    const closing = '(mv."openingStock" + mv."stockIn" - mv."stockOut")';
    const reserved = 'COALESCE(res."reservedQty", 0)';
    const available = `GREATEST(${closing} - ${reserved}, 0)`;
    const stockStatus = `
      CASE
        WHEN ${closing} <= 0 THEN 'OUT_OF_STOCK'
        WHEN pr."reorderLevel" IS NOT NULL AND ${closing} <= pr."reorderLevel" THEN 'BELOW_REORDER'
        WHEN pr."maxStock" IS NOT NULL AND ${closing} > pr."maxStock" THEN 'EXCESS'
        ELSE 'IN_STOCK'
      END`;
    if (p.stockStatus) where.raw(`${stockStatus} = ${where.param(p.stockStatus)}`);

    return {
      from: `
        (SELECT DISTINCT k0."factoryId", k0."productId" FROM stock_ledger_entries k0 WHERE ${keyClauses.join(' AND ')}) k
        JOIN products pr ON pr.id = k."productId"
        JOIN factories f ON f.id = k."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(CASE WHEN m."direction" = 'IN' THEN m.quantity ELSE -m.quantity END) FILTER (WHERE ${beforeWindow}), 0) AS "openingStock",
            COALESCE(SUM(m.quantity) FILTER (WHERE m."direction" = 'IN' AND ${inWindow}), 0) AS "stockIn",
            COALESCE(SUM(m.quantity) FILTER (WHERE m."direction" = 'OUT' AND ${inWindow}), 0) AS "stockOut",
            MAX(m."createdAt")::date AS "lastMovementDate"
          FROM stock_ledger_entries m
          WHERE m."factoryId" = k."factoryId" AND m."productId" = k."productId"
        ) mv ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(sr.quantity), 0) AS "reservedQty"
          FROM stock_reservations sr
          WHERE sr.status = 'ACTIVE' AND sr."factoryId" = k."factoryId" AND sr."productId" = k."productId"
        ) res ON TRUE`,
      select: `
        (k."factoryId"::text || ':' || k."productId"::text) AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        f."name" AS "factoryName",
        mv."openingStock", mv."stockIn", mv."stockOut",
        ${closing} AS "closingStock",
        ${reserved} AS "reservedQty",
        ${available} AS "availableQty",
        pr."reorderLevel",
        ${lotValue(closing, 'pr')} AS "stockValuePaise",
        mv."lastMovementDate",
        ${stockStatus} AS "stockStatus"`,
      where,
      tieBreak: 'pr."name"',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        factoryName: 'f."name"',
        openingStock: 'mv."openingStock"',
        stockIn: 'mv."stockIn"',
        stockOut: 'mv."stockOut"',
        closingStock: closing,
        reservedQty: reserved,
        availableQty: available,
        stockValuePaise: lotValue(closing, 'pr'),
        lastMovementDate: 'mv."lastMovementDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "skuCount",
        COALESCE(SUM(${closing}), 0) AS "closingStock",
        COALESCE(SUM(${reserved}), 0) AS "reservedQty",
        COALESCE(SUM(${available}), 0) AS "availableQty",
        COALESCE(SUM(${lotValue(closing, 'pr')}), 0) AS "stockValuePaise"`,
    };
  },
});

defineReport({
  id: 'inventory-movement',
  category: 'inventory',
  slug: 'movement',
  name: 'Stock Movement',
  description: 'Every stock ledger entry, with a running balance per product and location.',
  dateFieldLabel: 'Recorded On',
  limitations: [LEDGER_DATE_NOTE],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'movementType', 'referenceType'],
  searchFields: ['Product Code', 'Product Name', 'Lot No', 'Reference No'],
  defaultSort: { by: 'movementDate', dir: 'desc' },
  columns: [
    date('movementDate', 'Date'),
    code('lotNumber', 'Lot No'),
    text('movementType', 'Movement Type'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    text('factoryName', 'Location'),
    qty('quantityIn', 'Qty In'),
    qty('quantityOut', 'Qty Out'),
    qty('runningBalance', 'Balance'),
    text('referenceType', 'Reference Type'),
    text('notes', 'Notes', { sortable: false, hidden: true }),
    text('userName', 'User'),
  ],
  summary: [
    metric('entryCount', 'Movements', 'int'),
    metric('quantityIn', 'Total In', 'qty'),
    metric('quantityOut', 'Total Out', 'qty'),
    metric('netQuantity', 'Net Movement', 'qty'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('sle."tenantId"');
    where.factoryScope('sle."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('sle."createdAt"', p.dateFrom, p.dateTo, { timestamp: true });
    where.eq('sle."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('sle."movementType"', p.movementType);
    where.eq('sle."referenceType"', p.referenceType);
    where.search(['pr."code"', 'pr."name"', 'sl."lotNumber"', 'sle."referenceType"'], p.search);

    return {
      from: `
        stock_ledger_entries sle
        JOIN products pr ON pr.id = sle."productId"
        JOIN factories f ON f.id = sle."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN stock_lots sl ON sl.id = sle."lotId"
        LEFT JOIN employees e ON e.id = sle."createdBy"`,
      select: `
        sle.id AS "id",
        sle."createdAt"::date AS "movementDate",
        sl."lotNumber",
        sle."movementType",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName",
        f."name" AS "factoryName",
        CASE WHEN sle."direction" = 'IN' THEN sle.quantity ELSE 0 END AS "quantityIn",
        CASE WHEN sle."direction" = 'OUT' THEN sle.quantity ELSE 0 END AS "quantityOut",
        -- The window runs over the whole filtered set, before LIMIT, so the
        -- balance stays continuous from page to page. It is anchored to the
        -- ledger's own order, not the display sort, so re-sorting the table
        -- cannot silently change what "balance" means.
        SUM(${NET_QTY}) OVER (
          PARTITION BY sle."factoryId", sle."productId"
          ORDER BY sle."createdAt", sle.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "runningBalance",
        sle."referenceType",
        sle."notes",
        NULLIF(TRIM(COALESCE(e."firstName", '') || ' ' || COALESCE(e."lastName", '')), '') AS "userName"`,
      where,
      tieBreak: 'sle.id',
      sortMap: {
        movementDate: 'sle."createdAt"',
        lotNumber: 'sl."lotNumber"',
        movementType: 'sle."movementType"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        factoryName: 'f."name"',
        quantityIn: `CASE WHEN sle."direction" = 'IN' THEN sle.quantity ELSE 0 END`,
        quantityOut: `CASE WHEN sle."direction" = 'OUT' THEN sle.quantity ELSE 0 END`,
        referenceType: 'sle."referenceType"',
        userName: 'e."firstName"',
      },
      summarySelect: `
        COUNT(*)::int AS "entryCount",
        COALESCE(SUM(sle.quantity) FILTER (WHERE sle."direction" = 'IN'), 0) AS "quantityIn",
        COALESCE(SUM(sle.quantity) FILTER (WHERE sle."direction" = 'OUT'), 0) AS "quantityOut",
        COALESCE(SUM(${NET_QTY}), 0) AS "netQuantity"`,
    };
  },
});

defineReport({
  id: 'inventory-transfers',
  filterOptions: { status: { options: VOCABULARY.transferStatus } },
  category: 'inventory',
  slug: 'transfers',
  name: 'Stock Transfer Report',
  description: 'Stock moved between locations, with what was sent against what was received.',
  dateFieldLabel: 'Transfer Date',
  limitations: ['Created By is not shown: stock transfers do not record the user who raised them (the audit log does, per document).'],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'status'],
  searchFields: ['Transfer No', 'Vehicle No', 'Product Name'],
  defaultSort: { by: 'initiatedDate', dir: 'desc' },
  columns: [
    code('transferNumber', 'Transfer No'),
    date('initiatedDate', 'Transfer Date'),
    text('fromFactoryName', 'From Location'),
    text('toFactoryName', 'To Location'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    code('uomCode', 'UOM'),
    qty('quantity', 'Sent'),
    qty('receivedQuantity', 'Received'),
    qty('inTransitQty', 'In Transit'),
    code('vehicleNumber', 'Vehicle No'),
    date('receivedDate', 'Received Date'),
    status('status', 'Status'),
  ],
  summary: [
    metric('lineCount', 'Transfer Lines', 'int'),
    metric('transferCount', 'Transfers', 'int'),
    metric('quantity', 'Sent', 'qty'),
    metric('receivedQuantity', 'Received', 'qty'),
    metric('inTransitQty', 'In Transit', 'qty'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('st."tenantId"');
    where.dateRange('st."initiatedDate"', p.dateFrom, p.dateTo);
    where.eq('stl."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('st."status"', p.status);
    where.search(['st."transferNumber"', 'st."vehicleNumber"', 'pr."name"', 'pr."code"'], p.search);

    // A transfer touches two factories. Someone assigned to either end has a
    // legitimate interest in it, so the scope is "either side is mine" rather
    // than the single-column check the other reports use.
    if (p.factoryId) {
      if (allowedFactoryIds !== null && !allowedFactoryIds.includes(p.factoryId)) {
        // Delegate the identical error and message to the shared helper.
        where.factoryScope('st."fromFactoryId"', allowedFactoryIds, p.factoryId);
      } else {
        const id = where.param(p.factoryId);
        where.raw(`st."fromFactoryId" = ${id} OR st."toFactoryId" = ${id}`);
      }
    } else if (allowedFactoryIds !== null) {
      const ids = where.param(allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000']);
      where.raw(`st."fromFactoryId" = ANY(${ids}::uuid[]) OR st."toFactoryId" = ANY(${ids}::uuid[])`);
    }

    return {
      from: `
        stock_transfer_lines stl
        JOIN stock_transfers st ON st.id = stl."stockTransferId"
        JOIN factories ff ON ff.id = st."fromFactoryId"
        JOIN factories tf ON tf.id = st."toFactoryId"
        JOIN products pr ON pr.id = stl."productId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"`,
      select: `
        stl.id AS "id",
        st."transferNumber", st."initiatedDate",
        ff."name" AS "fromFactoryName", tf."name" AS "toFactoryName",
        pr."code" AS "productCode", pr."name" AS "productName", u."code" AS "uomCode",
        stl.quantity, COALESCE(stl."receivedQuantity", 0) AS "receivedQuantity",
        GREATEST(stl.quantity - COALESCE(stl."receivedQuantity", 0), 0) AS "inTransitQty",
        st."vehicleNumber", st."receivedDate",
        st."status"`,
      where,
      tieBreak: 'stl.id',
      sortMap: {
        transferNumber: 'st."transferNumber"',
        initiatedDate: 'st."initiatedDate"',
        fromFactoryName: 'ff."name"',
        toFactoryName: 'tf."name"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        quantity: 'stl.quantity',
        receivedQuantity: 'COALESCE(stl."receivedQuantity", 0)',
        inTransitQty: 'GREATEST(stl.quantity - COALESCE(stl."receivedQuantity", 0), 0)',
        vehicleNumber: 'st."vehicleNumber"',
        receivedDate: 'st."receivedDate"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COUNT(DISTINCT st.id)::int AS "transferCount",
        COALESCE(SUM(stl.quantity), 0) AS "quantity",
        COALESCE(SUM(COALESCE(stl."receivedQuantity", 0)), 0) AS "receivedQuantity",
        COALESCE(SUM(GREATEST(stl.quantity - COALESCE(stl."receivedQuantity", 0), 0)), 0) AS "inTransitQty"`,
    };
  },
});

defineReport({
  id: 'inventory-adjustments',
  filterOptions: { movementType: { label: 'Adjustment Type', options: VOCABULARY.adjustmentType } },
  category: 'inventory',
  slug: 'adjustments',
  name: 'Stock Adjustment Report',
  description: 'Manual stock corrections and breakage, with who recorded them and why.',
  dateFieldLabel: 'Recorded On',
  limitations: [
    LEDGER_DATE_NOTE,
    'Adjustment No, Previous Quantity and New Quantity are not shown: adjustments are recorded as stock ledger entries, ' +
      'not as a separate adjustment document, so there is no document number or before/after snapshot to report.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'movementType'],
  searchFields: ['Product Code', 'Product Name', 'Lot No', 'Notes'],
  defaultSort: { by: 'adjustmentDate', dir: 'desc' },
  columns: [
    date('adjustmentDate', 'Date'),
    text('factoryName', 'Location'),
    code('lotNumber', 'Lot No'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    code('uomCode', 'UOM'),
    text('movementType', 'Adjustment Type'),
    qty('adjustmentQty', 'Adjustment Qty'),
    text('notes', 'Reason', { sortable: false }),
    text('userName', 'Recorded By'),
  ],
  summary: [
    metric('entryCount', 'Adjustments', 'int'),
    metric('increaseQty', 'Increased By', 'qty'),
    metric('decreaseQty', 'Decreased By', 'qty'),
    metric('netQuantity', 'Net Adjustment', 'qty'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('sle."tenantId"');
    where.factoryScope('sle."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('sle."createdAt"', p.dateFrom, p.dateTo, { timestamp: true });
    where.eq('sle."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.search(['pr."code"', 'pr."name"', 'sl."lotNumber"', 'sle."notes"'], p.search);
    if (p.movementType) where.token('sle."movementType"', p.movementType);
    else where.raw(`sle."movementType" IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'BREAKAGE_OUT')`);

    return {
      from: `
        stock_ledger_entries sle
        JOIN products pr ON pr.id = sle."productId"
        JOIN factories f ON f.id = sle."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN stock_lots sl ON sl.id = sle."lotId"
        LEFT JOIN employees e ON e.id = sle."createdBy"`,
      select: `
        sle.id AS "id",
        sle."createdAt"::date AS "adjustmentDate",
        f."name" AS "factoryName",
        sl."lotNumber",
        pr."code" AS "productCode", pr."name" AS "productName", u."code" AS "uomCode",
        sle."movementType",
        ${NET_QTY} AS "adjustmentQty",
        sle."notes",
        NULLIF(TRIM(COALESCE(e."firstName", '') || ' ' || COALESCE(e."lastName", '')), '') AS "userName"`,
      where,
      tieBreak: 'sle.id',
      sortMap: {
        adjustmentDate: 'sle."createdAt"',
        factoryName: 'f."name"',
        lotNumber: 'sl."lotNumber"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        movementType: 'sle."movementType"',
        adjustmentQty: NET_QTY,
        userName: 'e."firstName"',
      },
      summarySelect: `
        COUNT(*)::int AS "entryCount",
        COALESCE(SUM(sle.quantity) FILTER (WHERE sle."direction" = 'IN'), 0) AS "increaseQty",
        COALESCE(SUM(sle.quantity) FILTER (WHERE sle."direction" = 'OUT'), 0) AS "decreaseQty",
        COALESCE(SUM(${NET_QTY}), 0) AS "netQuantity"`,
    };
  },
});

defineReport({
  id: 'inventory-reconciliation',
  category: 'inventory',
  slug: 'reconciliation',
  name: 'Stock Reconciliation',
  description: 'Lot balances against what the stock ledger says they should be, with the drift on each line.',
  limitations: [
    'This reconciles the system against itself — lot balances against the movement ledger — because there is no physical ' +
      'stock-count entity in this schema. Physical Quantity, Reconciliation Date and Approved By therefore have no source ' +
      'and are not shown. It is the same check StockLedgerService.reconcileLedgerVsBalances performs nightly.',
  ],
  filters: ['factoryId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Code', 'Product Name'],
  defaultSort: { by: 'variance', dir: 'desc' },
  columns: [
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    code('uomCode', 'UOM'),
    text('factoryName', 'Location'),
    qty('systemQty', 'System Quantity'),
    qty('ledgerQty', 'Ledger Quantity'),
    qty('variance', 'Variance'),
    percent('variancePercent', 'Variance %'),
    status('reconciliationStatus', 'Status'),
  ],
  summary: [
    metric('lineCount', 'Stock Lines', 'int'),
    metric('mismatchCount', 'Lines With Drift', 'int'),
    metric('systemQty', 'System Quantity', 'qty'),
    metric('ledgerQty', 'Ledger Quantity', 'qty'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('sl."tenantId"');
    where.factoryScope('sl."factoryId"', allowedFactoryIds, p.factoryId);
    where.eq('sl."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."code"', 'pr."name"'], p.search);

    const systemQty = 'COALESCE(SUM(sl."qtyAvailable"), 0)';
    const ledgerQty = 'COALESCE(SUM(led."netQty"), 0)';
    const variance = `(${systemQty} - ${ledgerQty})`;

    return {
      from: `
        stock_lots sl
        JOIN products pr ON pr.id = sl."productId"
        JOIN factories f ON f.id = sl."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(CASE WHEN e2."direction" = 'IN' THEN e2.quantity ELSE -e2.quantity END), 0) AS "netQty"
          FROM stock_ledger_entries e2 WHERE e2."lotId" = sl.id
        ) led ON TRUE`,
      select: `
        (sl."factoryId"::text || ':' || sl."productId"::text) AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        f."name" AS "factoryName",
        ${systemQty} AS "systemQty",
        ${ledgerQty} AS "ledgerQty",
        ${variance} AS "variance",
        CASE WHEN ${ledgerQty} = 0 THEN 0 ELSE ROUND(100.0 * ${variance} / ${ledgerQty}, 2) END AS "variancePercent",
        CASE WHEN ABS(${variance}) < 0.0001 THEN 'MATCHED' ELSE 'DRIFT' END AS "reconciliationStatus"`,
      where,
      groupBy: 'sl."factoryId", sl."productId", pr."code", pr."name", pc."name", u."code", f."name"',
      tieBreak: 'pr."name"',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        factoryName: 'f."name"',
        systemQty,
        ledgerQty,
        variance: `ABS(${variance})`,
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COUNT(*) FILTER (WHERE _s."reconciliationStatus" = 'DRIFT')::int AS "mismatchCount",
        COALESCE(SUM(_s."systemQty"), 0) AS "systemQty",
        COALESCE(SUM(_s."ledgerQty"), 0) AS "ledgerQty"`,
    };
  },
});
