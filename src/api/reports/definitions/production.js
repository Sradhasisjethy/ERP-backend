const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, percent, status, metric } = require('../lib/columns');

/**
 * Production reports.
 *
 * "Production Summary" and the brief's separate "Finished Goods Production"
 * are one report here: both describe the same production entries, and shipping
 * two menu items over one table is exactly the duplication the redesign is
 * meant to remove. Likewise "Production Detail" and "Raw Material Consumption"
 * are one report — both are the material_consumptions rows for an entry.
 *
 * In-house production (production_entries) and contractor job work
 * (contractor_production_entries) are genuinely different tables with different
 * economics, so those stay separate.
 */

defineReport({
  id: 'production-summary',
  category: 'production',
  slug: 'summary',
  name: 'Production Summary',
  description: 'Every production entry: planned against produced and rejected, with the BOM it was made to.',
  dateFieldLabel: 'Production Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'status'],
  searchFields: ['Production No', 'Product Name', 'Product Code'],
  defaultSort: { by: 'productionDate', dir: 'desc' },
  columns: [
    code('entryNumber', 'Production No'),
    date('productionDate', 'Production Date'),
    date('planDate', 'Plan Date'),
    code('productCode', 'Product Code'),
    text('productName', 'Product'),
    text('categoryName', 'Category'),
    text('mixDesignName', 'BOM'),
    code('uomCode', 'UOM'),
    qty('plannedQty', 'Planned'),
    qty('goodQty', 'Produced'),
    qty('rejectedQty', 'Rejected'),
    qty('pendingQty', 'Pending'),
    code('lotNumber', 'Lot', { hidden: true }),
    text('factoryName', 'Location'),
    status('status', 'Status'),
  ],
  summary: [
    metric('entryCount', 'Entries', 'int'),
    metric('plannedQty', 'Planned', 'qty'),
    metric('goodQty', 'Produced', 'qty'),
    metric('rejectedQty', 'Rejected', 'qty'),
    metric('rejectionRate', 'Rejection %', 'percent'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pe."tenantId"');
    where.factoryScope('pe."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('pe."productionDate"', p.dateFrom, p.dateTo);
    where.eq('pe."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('pe."status"', p.status || 'POSTED');
    where.search(['pe."entryNumber"', 'pr."name"', 'pr."code"'], p.search);

    // A plan line's confirmed quantity is what the floor was told to make;
    // requiredQty is the pre-confirmation ask. Prefer the confirmed figure and
    // fall back, rather than showing a plan number nobody committed to.
    const plannedQty = 'COALESCE(ppl."confirmedQty", ppl."requiredQty")';

    return {
      from: `
        production_entries pe
        JOIN products pr ON pr.id = pe."productId"
        JOIN factories f ON f.id = pe."factoryId"
        LEFT JOIN product_categories pc ON pc.id = pr."categoryId"
        LEFT JOIN uoms u ON u.id = pr."uomId"
        LEFT JOIN mix_designs md ON md.id = pe."mixDesignId"
        LEFT JOIN production_plan_lines ppl ON ppl.id = pe."productionPlanLineId"
        LEFT JOIN production_plans pp ON pp.id = ppl."productionPlanId"
        LEFT JOIN stock_lots sl ON sl.id = pe."lotId"`,
      select: `
        pe.id AS "id",
        pe."entryNumber", pe."productionDate", pp."planDate",
        pr."code" AS "productCode", pr."name" AS "productName",
        pc."name" AS "categoryName", md."name" AS "mixDesignName", u."code" AS "uomCode",
        ${plannedQty} AS "plannedQty",
        pe."goodQty", pe."rejectedQty",
        GREATEST(COALESCE(${plannedQty}, 0) - pe."goodQty", 0) AS "pendingQty",
        sl."lotNumber",
        f."name" AS "factoryName",
        pe."status"`,
      where,
      tieBreak: 'pe.id',
      sortMap: {
        entryNumber: 'pe."entryNumber"',
        productionDate: 'pe."productionDate"',
        planDate: 'pp."planDate"',
        productCode: 'pr."code"',
        productName: 'pr."name"',
        categoryName: 'pc."name"',
        mixDesignName: 'md."name"',
        plannedQty,
        goodQty: 'pe."goodQty"',
        rejectedQty: 'pe."rejectedQty"',
        pendingQty: `GREATEST(COALESCE(${plannedQty}, 0) - pe."goodQty", 0)`,
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "entryCount",
        COALESCE(SUM(${plannedQty}), 0) AS "plannedQty",
        COALESCE(SUM(pe."goodQty"), 0) AS "goodQty",
        COALESCE(SUM(pe."rejectedQty"), 0) AS "rejectedQty",
        CASE WHEN COALESCE(SUM(pe."goodQty" + pe."rejectedQty"), 0) = 0 THEN 0
             ELSE ROUND(100.0 * SUM(pe."rejectedQty") / SUM(pe."goodQty" + pe."rejectedQty"), 2) END AS "rejectionRate"`,
    };
  },
});

defineReport({
  id: 'production-consumption',
  category: 'production',
  slug: 'consumption',
  name: 'Raw Material Consumption',
  description: 'Material actually consumed against what the BOM called for, with the variance on each line.',
  dateFieldLabel: 'Production Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'productId', 'categoryId', 'status'],
  searchFields: ['Production No', 'Finished Product', 'Raw Material'],
  defaultSort: { by: 'productionDate', dir: 'desc' },
  columns: [
    code('entryNumber', 'Production No'),
    date('productionDate', 'Production Date'),
    code('productCode', 'FG Code'),
    text('productName', 'Finished Product'),
    qty('producedQty', 'Produced'),
    code('rawMaterialCode', 'RM Code'),
    text('rawMaterialName', 'Raw Material'),
    code('uomCode', 'UOM'),
    qty('plannedQty', 'BOM / Planned'),
    qty('actualQty', 'Consumed'),
    qty('varianceQty', 'Variance'),
    percent('variancePercent', 'Variance %'),
    text('factoryName', 'Location'),
    status('approvalStatus', 'Variance Approval'),
  ],
  summary: [
    metric('lineCount', 'Consumption Lines', 'int'),
    metric('plannedQty', 'Planned', 'qty'),
    metric('actualQty', 'Consumed', 'qty'),
    metric('varianceQty', 'Variance', 'qty'),
    metric('pendingApprovals', 'Awaiting Approval', 'int'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('pe."tenantId"');
    where.factoryScope('pe."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('pe."productionDate"', p.dateFrom, p.dateTo);
    where.eq('pe."productId"', p.productId);
    where.eq('rm."categoryId"', p.categoryId);
    where.token('pe."status"', p.status || 'POSTED');
    where.search(['pe."entryNumber"', 'fg."name"', 'rm."name"', 'rm."code"'], p.search);

    return {
      from: `
        material_consumptions mc
        JOIN production_entries pe ON pe.id = mc."productionEntryId"
        JOIN products fg ON fg.id = pe."productId"
        JOIN products rm ON rm.id = mc."rawMaterialProductId"
        JOIN factories f ON f.id = pe."factoryId"
        LEFT JOIN uoms u ON u.id = rm."uomId"`,
      select: `
        mc.id AS "id",
        pe."entryNumber", pe."productionDate",
        fg."code" AS "productCode", fg."name" AS "productName", pe."goodQty" AS "producedQty",
        rm."code" AS "rawMaterialCode", rm."name" AS "rawMaterialName", u."code" AS "uomCode",
        mc."mixDesignQty" AS "plannedQty",
        mc."actualQty",
        (mc."actualQty" - mc."mixDesignQty") AS "varianceQty",
        mc."variancePercent",
        f."name" AS "factoryName",
        CASE
          WHEN mc."requiresApproval" IS NOT TRUE THEN 'NOT_REQUIRED'
          WHEN mc."approvedBy" IS NOT NULL THEN 'APPROVED'
          ELSE 'PENDING'
        END AS "approvalStatus"`,
      where,
      tieBreak: 'mc.id',
      sortMap: {
        entryNumber: 'pe."entryNumber"',
        productionDate: 'pe."productionDate"',
        productName: 'fg."name"',
        rawMaterialName: 'rm."name"',
        rawMaterialCode: 'rm."code"',
        plannedQty: 'mc."mixDesignQty"',
        actualQty: 'mc."actualQty"',
        varianceQty: '(mc."actualQty" - mc."mixDesignQty")',
        variancePercent: 'mc."variancePercent"',
        factoryName: 'f."name"',
      },
      summarySelect: `
        COUNT(*)::int AS "lineCount",
        COALESCE(SUM(mc."mixDesignQty"), 0) AS "plannedQty",
        COALESCE(SUM(mc."actualQty"), 0) AS "actualQty",
        COALESCE(SUM(mc."actualQty" - mc."mixDesignQty"), 0) AS "varianceQty",
        COUNT(*) FILTER (WHERE mc."requiresApproval" IS TRUE AND mc."approvedBy" IS NULL)::int AS "pendingApprovals"`,
    };
  },
});

defineReport({
  id: 'production-by-contractor',
  category: 'production',
  slug: 'by-contractor',
  name: 'Production by Contractor',
  description: 'Job-work output per contractor, with what has been paid against it and what is still owed.',
  dateFieldLabel: 'Production Date',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'contractorId', 'productId', 'categoryId'],
  searchFields: ['Contractor Name', 'Contractor Code'],
  defaultSort: { by: 'totalValuePaise', dir: 'desc' },
  columns: [
    code('contractorCode', 'Contractor Code'),
    text('contractorName', 'Contractor'),
    int('entryCount', 'Production Entries'),
    int('productCount', 'Products'),
    qty('quantity', 'Quantity'),
    money('avgPieceRatePaise', 'Avg Piece Rate'),
    money('totalValuePaise', 'Production Value', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
  ],
  summary: [
    metric('contractorCount', 'Contractors', 'int'),
    metric('quantity', 'Quantity', 'qty'),
    metric('totalValuePaise', 'Production Value'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('cpe."tenantId"');
    where.factoryScope('cpe."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('cpe."productionDate"', p.dateFrom, p.dateTo);
    where.eq('cpe."contractorPartyId"', p.contractorId);
    where.eq('cpe."productId"', p.productId);
    where.eq('pr."categoryId"', p.categoryId);
    where.token('cpe."status"', 'POSTED');
    where.search(['ct."name"', 'ct."code"'], p.search);

    // Contractor dues live in the books, not on the production entry: job work
    // credits ACCOUNTS_PAYABLE for the party, advances and payments debit it
    // (see workforce.service.js). So credits are what they earned and debits
    // are what they have been given — the balance is lifetime, not period-bound,
    // because a payable is not a period figure.
    return {
      from: `
        contractor_production_entries cpe
        JOIN parties ct ON ct.id = cpe."contractorPartyId"
        JOIN products pr ON pr.id = cpe."productId"
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(jl."debitPaise"), 0) AS "paidPaise",
            COALESCE(SUM(jl."creditPaise"), 0) AS "earnedPaise"
          FROM journal_lines jl WHERE jl."partyId" = ct.id
        ) bal ON TRUE`,
      select: `
        ct.id AS "id",
        ct."code" AS "contractorCode", ct."name" AS "contractorName",
        COUNT(cpe.id)::int AS "entryCount",
        COUNT(DISTINCT cpe."productId")::int AS "productCount",
        COALESCE(SUM(cpe.quantity), 0) AS "quantity",
        CASE WHEN COALESCE(SUM(cpe.quantity), 0) = 0 THEN 0
             ELSE ROUND(SUM(cpe."totalValuePaise") / SUM(cpe.quantity)) END AS "avgPieceRatePaise",
        COALESCE(SUM(cpe."totalValuePaise"), 0) AS "totalValuePaise",
        MAX(bal."paidPaise") AS "paidPaise",
        GREATEST(MAX(bal."earnedPaise") - MAX(bal."paidPaise"), 0) AS "outstandingPaise"`,
      where,
      groupBy: 'ct.id, ct."code", ct."name"',
      tieBreak: 'ct."name"',
      sortMap: {
        contractorCode: 'ct."code"',
        contractorName: 'ct."name"',
        entryCount: 'COUNT(cpe.id)',
        quantity: 'COALESCE(SUM(cpe.quantity), 0)',
        totalValuePaise: 'COALESCE(SUM(cpe."totalValuePaise"), 0)',
        paidPaise: 'MAX(bal."paidPaise")',
        outstandingPaise: 'GREATEST(MAX(bal."earnedPaise") - MAX(bal."paidPaise"), 0)',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "contractorCount",
        COALESCE(SUM(_s.quantity), 0) AS "quantity",
        COALESCE(SUM(_s."totalValuePaise"), 0) AS "totalValuePaise",
        COALESCE(SUM(_s."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise"`,
    };
  },
});
