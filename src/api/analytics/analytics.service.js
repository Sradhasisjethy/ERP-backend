const { Op, fn, col, literal } = require('sequelize');
const { StockLot } = require('../inventory/stockLot.model');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { Product } = require('../products/product.model');
const { MixDesign } = require('../products/mixDesign.model');
const { MixDesignLine } = require('../products/mixDesignLine.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { SalesInvoiceLine } = require('../invoicing/salesInvoiceLine.model');
const { PurchaseInvoice } = require('../purchasing/purchaseInvoice.model');
const { PurchaseOrder } = require('../purchasing/purchaseOrder.model');
const { GoodsReceipt } = require('../purchasing/goodsReceipt.model');
const { DeliveryChallan } = require('../dispatch/deliveryChallan.model');
const { StockTransfer } = require('../transfer/stockTransfer.model');
const { ProductionEntry } = require('../production/productionEntry.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { Party } = require('../parties/party.model');
const { ContractorProductionEntry } = require('../workforce/contractorProductionEntry.model');
const { LedgerService } = require('../ledger/ledger.service');
const { getInvoiceAllocatedAmount } = require('../payments/payments.service');

const AGEING_BUCKETS = ['0-30', '31-60', '61-90', '90+'];
const bucketFor = (ageDays) => (ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+');
// Normalizes both sides to a whole calendar day (UTC midnight) before diffing
// so mixing a DATEONLY string ('2026-08-11') with a full timestamp
// ('2026-08-11T05:21:52Z', e.g. a StockLedgerEntry.createdAt) never yields a
// spurious negative day count from the time-of-day component.
const toDayUTC = (d) => {
  const date = new Date(d);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const daysBetween = (from, to) => Math.floor((toDayUTC(to) - toDayUTC(from)) / (1000 * 60 * 60 * 24));

/**
 * Phase 3 "Intelligence & Control" reporting: every method here is read-only
 * and derives its answer from documents that already exist elsewhere in the
 * system (stock lots/ledger, invoices, cancelled documents) — nothing in this
 * module posts to the ledger or mutates any other table.
 */
class AnalyticsService {
  // --- Stock ageing / dead stock ---
  static async getStockAgeing(factoryId, { deadStockDays = 90 } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const lots = await StockLot.findAll({
      where: { factoryId, status: 'AVAILABLE', qtyAvailable: { [Op.gt]: 0 } },
      include: [{ model: Product, as: 'product' }],
      order: [['originDate', 'ASC']],
    });

    const buckets = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, { count: 0, qty: 0, valuePaise: 0 }]));
    const deadStock = [];

    // Age is anchored to originDate, the same business-date field curing
    // promotion is anchored to (see stockLedger.service.js#promoteEligibleLots)
    // — not to StockLedgerEntry.createdAt, which is the row's real insert
    // time and can't be backdated the way a production/receipt date can.
    const rows = lots.map((lot) => {
      const ageDays = daysBetween(lot.originDate, today);
      const bucket = bucketFor(ageDays);
      const valuePaise = Math.round(Number(lot.qtyAvailable) * Number(lot.product?.standardCostPaise || 0));

      buckets[bucket].count += 1;
      buckets[bucket].qty += Number(lot.qtyAvailable);
      buckets[bucket].valuePaise += valuePaise;

      const row = {
        lotId: lot.id, lotNumber: lot.lotNumber, productId: lot.productId, productName: lot.product?.name,
        originDate: lot.originDate, ageDays, bucket, qtyAvailable: Number(lot.qtyAvailable), valuePaise,
      };
      if (ageDays >= deadStockDays) deadStock.push(row);
      return row;
    });

    return { asOfDate: today, deadStockDays, buckets, lots: rows, deadStock };
  }

  // --- Dashboard KPIs ---
  static async getDashboardKpis(factoryId, { fromDate, toDate } = {}) {
    const dateRange = fromDate && toDate ? { [Op.gte]: fromDate, [Op.lte]: toDate } : undefined;
    const invoiceWhere = { factoryId, status: 'POSTED', ...(dateRange ? { invoiceDate: dateRange } : {}) };

    const [salesTotal, purchaseTotal, dispatchCount, productionTotal, cashBalance, bankBalance, arBalance, apBalance] = await Promise.all([
      SalesInvoice.sum('totalPaise', { where: invoiceWhere }),
      PurchaseInvoice.sum('amountPaise', { where: { factoryId, ...(dateRange ? { invoiceDate: dateRange } : {}) } }),
      DeliveryChallan.count({ where: { factoryId, status: 'DISPATCHED', ...(dateRange ? { dispatchDate: dateRange } : {}) } }),
      ProductionEntry.sum('goodQty', { where: { factoryId, status: 'POSTED', ...(dateRange ? { productionDate: dateRange } : {}) } }),
      LedgerService.getOrCreateSystemAccount('CASH').then((a) => LedgerService.getAccountBalance(a.id, factoryId)),
      LedgerService.getOrCreateSystemAccount('BANK').then((a) => LedgerService.getAccountBalance(a.id, factoryId)),
      LedgerService.getOrCreateSystemAccount('ACCOUNTS_RECEIVABLE').then((a) => LedgerService.getAccountBalance(a.id, factoryId)),
      LedgerService.getOrCreateSystemAccount('ACCOUNTS_PAYABLE').then((a) => LedgerService.getAccountBalance(a.id, factoryId)),
    ]);

    const topProducts = await SalesInvoiceLine.findAll({
      attributes: ['productId', [fn('SUM', col('taxableAmountPaise')), 'totalPaise']],
      include: [
        { model: SalesInvoice, as: 'salesInvoice', attributes: [], where: invoiceWhere, required: true },
        { model: Product, as: 'product', attributes: ['name'] },
      ],
      group: ['productId', 'product.id', 'product.name'],
      order: [[literal('"totalPaise"'), 'DESC']],
      limit: 5,
      raw: true,
    });

    const topCustomers = await SalesInvoice.findAll({
      attributes: ['customerPartyId', [fn('SUM', col('totalPaise')), 'totalPaise']],
      where: invoiceWhere,
      include: [{ model: Party, as: 'customer', attributes: ['name'] }],
      group: ['customerPartyId', 'customer.id', 'customer.name'],
      order: [[literal('"totalPaise"'), 'DESC']],
      limit: 5,
      raw: true,
    });

    return {
      period: { fromDate: fromDate || null, toDate: toDate || null },
      salesValuePaise: Number(salesTotal || 0),
      purchaseValuePaise: Number(purchaseTotal || 0),
      dispatchCount,
      productionQty: Number(productionTotal || 0),
      cashBalancePaise: cashBalance,
      bankBalancePaise: bankBalance,
      outstandingReceivablesPaise: arBalance,
      outstandingPayablesPaise: -apBalance, // AP is naturally credit-heavy (negative debit-credit); report as a positive "amount owed" figure.
      topProducts: topProducts.map((r) => ({ productId: r.productId, productName: r['product.name'], totalPaise: Number(r.totalPaise) })),
      topCustomers: topCustomers.map((r) => ({ customerPartyId: r.customerPartyId, customerName: r['customer.name'], totalPaise: Number(r.totalPaise) })),
    };
  }

  // --- Product costing ---
  static async getCostingReport(factoryId) {
    const mixDesigns = await MixDesign.findAll({
      where: { isActive: true },
      include: [
        { model: Product, as: 'product', where: { productType: 'FINISHED_GOOD' } },
        { model: MixDesignLine, as: 'lines', include: [{ model: Product, as: 'rawMaterial' }] },
      ],
    });

    const rows = [];
    for (const mix of mixDesigns) {
      const standardCostPaise = Math.round(
        mix.lines.reduce((sum, line) => sum + Number(line.quantityPerUnit) * Number(line.rawMaterial?.standardCostPaise || 0), 0)
      );

      const salesAgg = await SalesInvoiceLine.findOne({
        attributes: [[fn('AVG', col('SalesInvoiceLine.ratePaise')), 'avgRate']],
        include: [{ model: SalesInvoice, as: 'salesInvoice', attributes: [], where: { factoryId, status: 'POSTED' }, required: true }],
        where: { productId: mix.productId },
        raw: true,
      });
      const contractorAgg = await ContractorProductionEntry.findOne({
        attributes: [[fn('AVG', col('pieceRatePaise')), 'avgRate']],
        where: { factoryId, productId: mix.productId, status: 'POSTED' },
        raw: true,
      });

      const avgSellingRatePaise = salesAgg?.avgRate ? Math.round(Number(salesAgg.avgRate)) : null;
      const marginPaise = avgSellingRatePaise !== null ? avgSellingRatePaise - standardCostPaise : null;

      rows.push({
        productId: mix.productId,
        productName: mix.product?.name,
        mixDesignName: mix.name,
        standardCostPaise,
        avgSellingRatePaise,
        marginPaise,
        marginPercent: avgSellingRatePaise ? Number(((marginPaise / avgSellingRatePaise) * 100).toFixed(2)) : null,
        avgContractorPieceRatePaise: contractorAgg?.avgRate ? Math.round(Number(contractorAgg.avgRate)) : null,
      });
    }

    return rows;
  }

  // --- Alerts (scans conditions across the system; nothing is persisted) ---
  static async getAlerts(factoryId) {
    const alerts = [];

    const negativeStockEvents = await StockLedgerEntry.findAll({
      where: { factoryId, isNegativeStockEvent: true },
      include: [{ model: Product, as: 'product', attributes: ['name'] }],
      order: [['createdAt', 'DESC']],
      limit: 20,
    });
    for (const entry of negativeStockEvents) {
      alerts.push({
        type: 'NEGATIVE_STOCK', severity: 'high',
        message: `${entry.product?.name} went negative via a ${entry.movementType} movement`,
        refType: 'StockLedgerEntry', refId: entry.id, date: entry.createdAt,
      });
    }

    const ageing = await this.getStockAgeing(factoryId);
    for (const lot of ageing.deadStock.slice(0, 20)) {
      alerts.push({
        type: 'DEAD_STOCK', severity: 'medium',
        message: `${lot.productName} lot ${lot.lotNumber} has been idle ${lot.ageDays} days (qty ${lot.qtyAvailable})`,
        refType: 'StockLot', refId: lot.lotId, date: lot.originDate,
      });
    }

    const overdueCutoff = new Date();
    overdueCutoff.setDate(overdueCutoff.getDate() - 30);
    const openInvoices = await SalesInvoice.findAll({
      where: { factoryId, status: 'POSTED', invoiceDate: { [Op.lte]: overdueCutoff.toISOString().slice(0, 10) } },
      include: [{ model: Party, as: 'customer', attributes: ['name'] }],
      order: [['invoiceDate', 'ASC']],
      limit: 100,
    });
    for (const invoice of openInvoices) {
      const allocated = await getInvoiceAllocatedAmount('SALES', invoice.id);
      const outstandingPaise = Number(invoice.totalPaise) - allocated;
      if (outstandingPaise > 0) {
        const daysOverdue = daysBetween(invoice.invoiceDate, new Date().toISOString().slice(0, 10));
        alerts.push({
          type: 'OVERDUE_RECEIVABLE', severity: daysOverdue > 90 ? 'high' : 'medium',
          // BR-27: the amount owed is money — kept out of `message` prose (which
          // isn't subject to field-level masking) and carried in `outstandingPaise` instead.
          message: `${invoice.customer?.name} has an overdue invoice ${invoice.invoiceNumber}, ${daysOverdue} days overdue`,
          outstandingPaise,
          refType: 'SalesInvoice', refId: invoice.id, date: invoice.invoiceDate,
        });
      }
    }

    const cashAccount = await LedgerService.getOrCreateSystemAccount('CASH');
    const cashBalance = await LedgerService.getAccountBalance(cashAccount.id, factoryId);
    if (cashBalance < 0) {
      alerts.push({
        type: 'NEGATIVE_CASH', severity: 'high', message: 'Factory cash balance is negative',
        balancePaise: cashBalance, refType: 'Account', refId: cashAccount.id, date: new Date().toISOString(),
      });
    }

    const severityRank = { high: 0, medium: 1, low: 2 };
    return alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  }

  // --- Cancellation analytics ---
  static async getCancellationAnalytics(factoryId, { fromDate, toDate } = {}) {
    const dateField = {
      SalesOrder: 'orderDate', PurchaseOrder: 'orderDate', GoodsReceipt: 'receiptDate',
      DeliveryChallan: 'dispatchDate', StockTransfer: 'initiatedDate', ProductionEntry: 'productionDate', SalesInvoice: 'invoiceDate',
    };
    const valueField = {
      SalesOrder: null, PurchaseOrder: 'totalAmountPaise', GoodsReceipt: null,
      DeliveryChallan: null, StockTransfer: null, ProductionEntry: null, SalesInvoice: 'totalPaise',
    };
    // StockTransfer has no single `factoryId` — it's scoped by its origin factory instead.
    const factoryField = { StockTransfer: 'fromFactoryId' };
    const models = { SalesOrder, PurchaseOrder, GoodsReceipt, DeliveryChallan, StockTransfer, ProductionEntry, SalesInvoice };

    const byDocumentType = [];
    let totalCancelled = 0;

    for (const [name, Model] of Object.entries(models)) {
      const where = { [factoryField[name] || 'factoryId']: factoryId, status: 'CANCELLED' };
      if (fromDate && toDate && dateField[name]) where[dateField[name]] = { [Op.gte]: fromDate, [Op.lte]: toDate };

      const rows = await Model.findAll({ where, attributes: ['cancelReason', ...(valueField[name] ? [valueField[name]] : [])], raw: true });
      if (!rows.length) continue;

      const reasonCounts = {};
      let totalValuePaise = 0;
      for (const row of rows) {
        const reason = row.cancelReason || 'No reason given';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        if (valueField[name]) totalValuePaise += Number(row[valueField[name]] || 0);
      }

      const topReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
      byDocumentType.push({ documentType: name, count: rows.length, totalValuePaise: valueField[name] ? totalValuePaise : null, topReasons });
      totalCancelled += rows.length;
    }

    return { period: { fromDate: fromDate || null, toDate: toDate || null }, totalCancelled, byDocumentType };
  }

  // --- Document search ---
  static async searchDocuments(query, { limit = 10 } = {}) {
    if (!query || query.trim().length < 2) return [];
    const like = { [Op.iLike]: `%${query.trim()}%` };

    const searches = [
      { documentType: 'SalesOrder', Model: SalesOrder, numberField: 'orderNumber', dateField: 'orderDate' },
      { documentType: 'PurchaseOrder', Model: PurchaseOrder, numberField: 'poNumber', dateField: 'orderDate' },
      { documentType: 'GoodsReceipt', Model: GoodsReceipt, numberField: 'grnNumber', dateField: 'receiptDate' },
      { documentType: 'PurchaseInvoice', Model: PurchaseInvoice, numberField: 'vendorInvoiceNumber', dateField: 'invoiceDate' },
      { documentType: 'DeliveryChallan', Model: DeliveryChallan, numberField: 'challanNumber', dateField: 'dispatchDate' },
      { documentType: 'SalesInvoice', Model: SalesInvoice, numberField: 'invoiceNumber', dateField: 'invoiceDate' },
    ];

    const results = await Promise.all(
      searches.map(async ({ documentType, Model, numberField, dateField }) => {
        const rows = await Model.findAll({ where: { [numberField]: like }, limit, order: [[dateField, 'DESC']], raw: true });
        return rows.map((row) => ({ documentType, id: row.id, number: row[numberField], date: row[dateField] }));
      })
    );

    return results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
  }
}

module.exports = { AnalyticsService };
