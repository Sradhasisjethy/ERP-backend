const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');
const { lotValue } = require('../lib/fragments');
const { GLOBAL_DEFAULTS } = require('../../inventory/ageing.service');

/**
 * Stock ageing, dead stock and slow-moving stock.
 *
 * These are one query with a different band selected, not three reports — the
 * rows, the thresholds and the value arithmetic are identical, and shipping
 * three copies of them is how they drift apart.
 *
 * Thresholds are NOT hardcoded. They resolve the same way
 * AgeingService.resolveThresholds does — Product, then Category, then Factory,
 * then the global default, taking the most specific non-null value **per
 * field**, so a product that overrides only deadStockDays still inherits
 * slowMovingDays from its category. The global fallbacks are imported from the
 * ageing service rather than restated, so the two cannot disagree.
 *
 * Age is computed live from originDate rather than read from the nightly
 * `ageDays` column, so the report is right even on the day a lot is created,
 * before the nightly reclassification has run. CURING lots are excluded, as
 * they are from the nightly job (FR-M22-3): stock that is not sellable yet is
 * not slow-moving.
 */

const threshold = (field) => `COALESCE(pr."${field}", pc."${field}", f."${field}", ${GLOBAL_DEFAULTS[field]})`;

const SLOW = threshold('slowMovingDays');
const DEAD = threshold('deadStockDays');
const AGE_DAYS = `(CURRENT_DATE - sl."originDate")::int`;
const AGEING_CLASS = `
  CASE
    WHEN ${AGE_DAYS} >= ${DEAD} THEN 'DEAD'
    WHEN ${AGE_DAYS} >= ${SLOW} THEN 'SLOW_MOVING'
    ELSE 'FRESH'
  END`;

const AGEING_LIMITATIONS = [
  'Stock value is at standard cost — the only cost this schema records against a product.',
  'Age is measured from the lot origin date (production, receipt or return), which is the same anchor curing promotion uses.',
];

/**
 * Shared builder. `fixedClass` locks the report to one ageing band; passing
 * null leaves the band as a user filter.
 */
const buildAgeing = (fixedClass) =>
  function build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('sl."tenantId"');
    where.factoryScope('sl."factoryId"', allowedFactoryIds, p.factoryId);
    where.eq('sl."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pr."productType"', p.productType);
    where.search(['pr."code"', 'pr."name"', 'sl."lotNumber"'], p.search);
    where.raw(`sl."status" = 'AVAILABLE' AND sl."qtyAvailable" > 0`);
    where.dateRange('sl."originDate"', p.dateFrom, p.dateTo);

    const band = fixedClass || p.ageingClass;
    if (band) where.raw(`${AGEING_CLASS} = ${where.param(band)}`);

    const value = lotValue('sl."qtyAvailable"', 'pr');
    const daysOverThreshold = `GREATEST(${AGE_DAYS} - ${DEAD}, 0)`;

    return {
      from: `
        stock_lots sl
        JOIN products pr ON pr.id = sl."productId"
        JOIN factories f ON f.id = sl."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN LATERAL (
          SELECT MAX(e."createdAt")::date AS "lastMovementDate"
          FROM stock_ledger_entries e WHERE e."lotId" = sl.id
        ) mv ON TRUE`,
      select: `
        sl.id AS "id",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", u."code" AS "uomCode",
        f."name" AS "factoryName",
        sl."lotNumber",
        sl."qtyAvailable" AS "quantity",
        ${value} AS "stockValuePaise",
        sl."originDate", mv."lastMovementDate",
        ${AGE_DAYS} AS "ageDays",
        ${SLOW} AS "slowMovingDays",
        ${DEAD} AS "deadStockDays",
        ${daysOverThreshold} AS "daysOverThreshold",
        GREATEST((CURRENT_DATE - COALESCE(mv."lastMovementDate", sl."originDate"))::int, 0) AS "daysSinceLastMovement",
        ${AGEING_CLASS} AS "ageingClass"`,
      where,
      tieBreak: 'sl.id',
      sortMap: {
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        factoryName: 'f."name"',
        lotNumber: 'sl."lotNumber"',
        quantity: 'sl."qtyAvailable"',
        stockValuePaise: value,
        originDate: 'sl."originDate"',
        lastMovementDate: 'mv."lastMovementDate"',
        ageDays: AGE_DAYS,
        daysOverThreshold,
        daysSinceLastMovement: 'GREATEST((CURRENT_DATE - COALESCE(mv."lastMovementDate", sl."originDate"))::int, 0)',
      },
      summarySelect: `
        COUNT(*)::int AS "lotCount",
        COUNT(DISTINCT sl."productId")::int AS "skuCount",
        COALESCE(SUM(sl."qtyAvailable"), 0) AS "quantity",
        COALESCE(SUM(${value}), 0) AS "stockValuePaise",
        COALESCE(ROUND(AVG(${AGE_DAYS})), 0) AS "avgAgeDays",
        COUNT(*) FILTER (WHERE ${AGEING_CLASS} = 'DEAD')::int AS "deadLotCount",
        COALESCE(SUM(${value}) FILTER (WHERE ${AGEING_CLASS} = 'DEAD'), 0) AS "deadValuePaise"`,
    };
  };

const AGEING_COLUMNS = [
  code('productCode', 'Product Code'),
  text('productName', 'Product'),
  text('categoryName', 'Category'),
  code('uomCode', 'UOM'),
  text('factoryName', 'Location'),
  code('lotNumber', 'Lot No'),
  qty('quantity', 'Quantity'),
  money('stockValuePaise', 'Stock Value', { total: true }),
  date('originDate', 'Stock-In Date'),
  date('lastMovementDate', 'Last Movement'),
  int('ageDays', 'Age (days)'),
  int('daysSinceLastMovement', 'Days Since Movement'),
  int('slowMovingDays', 'Slow-Moving Threshold', { hidden: true }),
  int('deadStockDays', 'Dead-Stock Threshold'),
  int('daysOverThreshold', 'Days Over Threshold'),
  status('ageingClass', 'Age Bucket'),
];

const AGEING_SUMMARY = [
  metric('lotCount', 'Lots', 'int'),
  metric('skuCount', 'Products', 'int'),
  metric('quantity', 'Quantity', 'qty'),
  metric('stockValuePaise', 'Stock Value'),
  metric('avgAgeDays', 'Average Age (days)', 'int'),
];

defineReport({
  id: 'stock-ageing',
  category: 'ageing',
  slug: 'stock-ageing',
  name: 'Stock Ageing',
  description: 'Every open lot with its age, against the ageing policy configured for that product, category or location.',
  dateFieldLabel: 'Stock-In Date',
  limitations: AGEING_LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'productType', 'ageingClass'],
  searchFields: ['Product Code', 'Product Name', 'Lot No'],
  defaultSort: { by: 'ageDays', dir: 'desc' },
  columns: AGEING_COLUMNS,
  summary: [
    ...AGEING_SUMMARY,
    metric('deadLotCount', 'Dead Lots', 'int'),
    metric('deadValuePaise', 'Dead Stock Value'),
  ],
  build: buildAgeing(null),
});

defineReport({
  id: 'dead-stock',
  category: 'ageing',
  slug: 'dead-stock',
  name: 'Dead Stock',
  description: 'Lots that have passed their configured dead-stock threshold, and by how far.',
  dateFieldLabel: 'Stock-In Date',
  limitations: AGEING_LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Code', 'Product Name', 'Lot No'],
  defaultSort: { by: 'daysOverThreshold', dir: 'desc' },
  columns: AGEING_COLUMNS,
  summary: [
    metric('lotCount', 'Dead Lots', 'int'),
    metric('skuCount', 'Dead SKUs', 'int'),
    metric('quantity', 'Dead Quantity', 'qty'),
    metric('stockValuePaise', 'Dead Stock Value'),
    metric('avgAgeDays', 'Average Age (days)', 'int'),
  ],
  build: buildAgeing('DEAD'),
});

defineReport({
  id: 'slow-moving-stock',
  category: 'ageing',
  slug: 'slow-moving',
  name: 'Slow Moving Stock',
  description: 'Lots past the slow-moving threshold but not yet dead — the stock still worth acting on.',
  dateFieldLabel: 'Stock-In Date',
  limitations: AGEING_LIMITATIONS,
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'productType'],
  searchFields: ['Product Code', 'Product Name', 'Lot No'],
  defaultSort: { by: 'ageDays', dir: 'desc' },
  columns: AGEING_COLUMNS,
  summary: [
    metric('lotCount', 'Slow-Moving Lots', 'int'),
    metric('skuCount', 'Products', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('stockValuePaise', 'Stock Value'),
    metric('avgAgeDays', 'Average Age (days)', 'int'),
  ],
  build: buildAgeing('SLOW_MOVING'),
});
