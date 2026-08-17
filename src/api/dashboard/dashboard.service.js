const { Op, fn, col, literal } = require('sequelize');
const { Factory } = require('../factory/factory.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { StockLot } = require('../inventory/stockLot.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { PurchaseInvoice } = require('../purchasing/purchaseInvoice.model');
const { DeliveryChallan } = require('../dispatch/deliveryChallan.model');
const { ProductionEntry } = require('../production/productionEntry.model');
const { MaterialConsumption } = require('../production/materialConsumption.model');
const { Notification } = require('../notifications/notification.model');
const { LedgerService } = require('../ledger/ledger.service');
const { getInvoiceAllocatedAmount } = require('../payments/payments.service');

/**
 * M23 — role-aware dashboard.
 *
 * AC-14.1 is the governing constraint: for a user without finance.view_rates,
 * financial widgets must be **absent from the API response entirely**, not
 * merely hidden by the UI. So the widget set is assembled server-side from the
 * caller's permissions; a Factory Manager's response simply has no `financial`
 * key to inspect in DevTools.
 */

/**
 * BR-29: `null` means "no factory restriction" (cross-factory visibility);
 * an EMPTY array means "no factories at all" and must match nothing.
 *
 * Conflating the two is a privilege-escalation bug — a falsy-length check
 * would turn "you may see nothing" into "you may see everything", which is
 * precisely what a scoped user requesting someone else's factory produces.
 */
const factoryScope = (factoryIds) => {
  if (factoryIds === null || factoryIds === undefined) return {};
  return { factoryId: { [Op.in]: factoryIds } }; // [] yields IN (NULL) -> no rows
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

class DashboardService {
  /** Widgets any authenticated user may see — quantities and counts, no money. */
  static async getOperationalWidgets(factoryIds) {
    const factoryFilter = factoryScope(factoryIds);
    const today = todayISO();
    const monthStart = monthStartISO();

    const [
      productionToday, productionMTD, dispatchesToday, pendingOrders,
      curingLots, deadLots, slowMovingLots, pendingApprovals, unreadAlerts,
    ] = await Promise.all([
      ProductionEntry.sum('goodQty', { where: { ...factoryFilter, status: 'POSTED', productionDate: today } }),
      ProductionEntry.sum('goodQty', { where: { ...factoryFilter, status: 'POSTED', productionDate: { [Op.gte]: monthStart } } }),
      DeliveryChallan.count({ where: { ...factoryFilter, status: 'DISPATCHED', dispatchDate: today } }),
      SalesOrder.count({ where: { ...factoryFilter, status: { [Op.in]: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] } } }),
      StockLot.count({ where: { ...factoryFilter, status: 'CURING' } }),
      StockLot.count({ where: { ...factoryFilter, ageingClass: 'DEAD', qtyAvailable: { [Op.gt]: 0 } } }),
      StockLot.count({ where: { ...factoryFilter, ageingClass: 'SLOW_MOVING', qtyAvailable: { [Op.gt]: 0 } } }),
      MaterialConsumption.count({ where: { requiresApproval: true, approvedBy: null } }),
      Notification.count({ where: { readAt: null } }),
    ]);

    // FR-M23-3: what finishes curing in the next 7 days is what the factory can
    // promise next week — the single most actionable number on this screen.
    const weekOut = new Date();
    weekOut.setDate(weekOut.getDate() + 7);
    const curingSoon = await StockLot.findAll({
      where: {
        ...factoryFilter,
        status: 'CURING',
        // Both StockLot and the joined Product carry curingDays, so the
        // columns must be table-qualified or Postgres rejects the reference.
        [Op.and]: [
          literal(
            `"StockLot"."originDate" + ("StockLot"."curingDays" || ' days')::interval <= '${weekOut.toISOString().slice(0, 10)}'`
          ),
        ],
      },
      include: [{ model: Product, as: 'product', attributes: ['name'] }],
      limit: 10,
      order: [['originDate', 'ASC']],
    });

    // Raw materials below their reorder level (FR-M23-3).
    const belowReorder = await Product.findAll({
      where: { productType: 'RAW_MATERIAL', reorderLevel: { [Op.gt]: 0 } },
      attributes: ['id', 'name', 'reorderLevel'],
      limit: 50,
    });
    const reorderAlerts = [];
    for (const product of belowReorder) {
      const onHand = await StockLot.sum('qtyAvailable', {
        where: { ...factoryFilter, productId: product.id, status: 'AVAILABLE' },
      });
      if (Number(onHand || 0) < Number(product.reorderLevel)) {
        reorderAlerts.push({ productId: product.id, productName: product.name, onHand: Number(onHand || 0), reorderLevel: Number(product.reorderLevel) });
      }
    }

    const rejectionAgg = await ProductionEntry.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('goodQty')), 0), 'good'],
        [fn('COALESCE', fn('SUM', col('rejectedQty')), 0), 'rejected'],
      ],
      where: { ...factoryFilter, status: 'POSTED', productionDate: { [Op.gte]: monthStart } },
      raw: true,
    });
    const good = Number(rejectionAgg?.good || 0);
    const rejected = Number(rejectionAgg?.rejected || 0);

    return {
      productionToday: Number(productionToday || 0),
      productionMTD: Number(productionMTD || 0),
      dispatchesToday,
      pendingOrders,
      curingLots,
      deadStockLots: deadLots,
      slowMovingLots: slowMovingLots,
      pendingVarianceApprovals: pendingApprovals,
      unreadAlerts,
      rejectionPercent: good + rejected > 0 ? Number(((rejected / (good + rejected)) * 100).toFixed(2)) : 0,
      yieldPercent: good + rejected > 0 ? Number(((good / (good + rejected)) * 100).toFixed(2)) : 100,
      curingCompletingThisWeek: curingSoon.map((l) => ({
        lotId: l.id, lotNumber: l.lotNumber, productName: l.product?.name,
        quantity: Number(l.qtyAvailable), originDate: l.originDate, curingDays: l.curingDays,
      })),
      reorderAlerts,
    };
  }

  /**
   * Widgets gated behind finance.view_rates. Never called — and therefore never
   * present in the response — for users who lack it (AC-14.1).
   */
  static async getFinancialWidgets(factoryIds) {
    const factoryFilter = factoryScope(factoryIds);
    const monthStart = monthStartISO();
    const today = todayISO();

    const [salesToday, salesMTD, purchaseMTD] = await Promise.all([
      SalesInvoice.sum('totalPaise', { where: { ...factoryFilter, status: 'POSTED', invoiceDate: today } }),
      SalesInvoice.sum('totalPaise', { where: { ...factoryFilter, status: 'POSTED', invoiceDate: { [Op.gte]: monthStart } } }),
      PurchaseInvoice.sum('amountPaise', { where: { ...factoryFilter, invoiceDate: { [Op.gte]: monthStart } } }),
    ]);

    // Cash/bank per factory, so a manager can see where the money actually is.
    const factories = await Factory.findAll({
      where: factoryIds ? { id: { [Op.in]: factoryIds } } : {},
      attributes: ['id', 'name'],
    });
    const cashAccount = await LedgerService.getOrCreateSystemAccount('CASH');
    const bankAccount = await LedgerService.getOrCreateSystemAccount('BANK');

    const cashByFactory = [];
    let cashTotal = 0;
    let bankTotal = 0;
    for (const factory of factories) {
      const cash = await LedgerService.getAccountBalance(cashAccount.id, factory.id);
      const bank = await LedgerService.getAccountBalance(bankAccount.id, factory.id);
      cashTotal += cash;
      bankTotal += bank;
      cashByFactory.push({ factoryId: factory.id, factoryName: factory.name, cashPaise: cash, bankPaise: bank });
    }

    // Receivables with ageing buckets (FR-M21-6 / FR-M23-4).
    const openInvoices = await SalesInvoice.findAll({
      where: { ...factoryFilter, status: 'POSTED' },
      include: [{ model: Party, as: 'customer', attributes: ['id', 'name'] }],
      limit: 1000,
    });

    const buckets = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90Plus: 0 };
    let receivablesTotal = 0;
    const now = new Date();
    for (const invoice of openInvoices) {
      const allocated = await getInvoiceAllocatedAmount('SALES', invoice.id);
      const outstanding = Number(invoice.totalPaise) - allocated;
      if (outstanding <= 0) continue;
      receivablesTotal += outstanding;

      const ageDays = Math.floor((now - new Date(invoice.invoiceDate)) / 86400000);
      const creditDays = Number(invoice.customer?.creditAgeingDays || 0) || 30;
      const overdue = ageDays - creditDays;
      if (overdue <= 0) buckets.notDue += outstanding;
      else if (overdue <= 30) buckets.d1_30 += outstanding;
      else if (overdue <= 60) buckets.d31_60 += outstanding;
      else if (overdue <= 90) buckets.d61_90 += outstanding;
      else buckets.d90Plus += outstanding;
    }

    const apAccount = await LedgerService.getOrCreateSystemAccount('ACCOUNTS_PAYABLE');
    const apBalance = await LedgerService.getAccountBalance(apAccount.id, null);

    // Dead stock as a share of inventory value (FR-M23-2). Valued at standard
    // cost, which lives on the joined Product.
    const valueOfLots = async (extraWhere) => {
      const row = await StockLot.findOne({
        attributes: [[literal('COALESCE(SUM("StockLot"."qtyAvailable" * "product"."standardCostPaise"), 0)'), 'value']],
        where: { ...factoryFilter, qtyAvailable: { [Op.gt]: 0 }, ...extraWhere },
        include: [{ model: Product, as: 'product', attributes: [] }],
        raw: true,
      });
      return Number(row?.value || 0);
    };

    const [deadPaise, totalPaise] = await Promise.all([
      valueOfLots({ ageingClass: 'DEAD' }),
      valueOfLots({}),
    ]);

    return {
      salesTodayPaise: Number(salesToday || 0),
      salesMTDPaise: Number(salesMTD || 0),
      purchaseMTDPaise: Number(purchaseMTD || 0),
      cashBalancePaise: cashTotal,
      bankBalancePaise: bankTotal,
      cashByFactory,
      receivablesPaise: receivablesTotal,
      receivablesAgeing: buckets,
      payablesPaise: -apBalance,
      deadStockValuePaise: deadPaise,
      inventoryValuePaise: totalPaise,
      deadStockPercent: totalPaise > 0 ? Number(((deadPaise / totalPaise) * 100).toFixed(2)) : 0,
    };
  }

  /** FR-M23-7: 12-month trend for the charts. */
  static async getTrends(factoryIds, { includeFinancial }) {
    const factoryFilter = factoryScope(factoryIds);
    const months = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date();
      d.setMonth(d.getMonth() - i, 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      months.push({ label: start.slice(0, 7), start, end });
    }

    const series = [];
    for (const month of months) {
      const production = await ProductionEntry.sum('goodQty', {
        where: { ...factoryFilter, status: 'POSTED', productionDate: { [Op.between]: [month.start, month.end] } },
      });
      const point = { month: month.label, production: Number(production || 0) };

      if (includeFinancial) {
        const sales = await SalesInvoice.sum('totalPaise', {
          where: { ...factoryFilter, status: 'POSTED', invoiceDate: { [Op.between]: [month.start, month.end] } },
        });
        point.salesPaise = Number(sales || 0);
      }
      series.push(point);
    }
    return series;
  }

  /**
   * Assembles the dashboard for one caller. `canViewRates` decides whether the
   * financial half is computed at all — not just whether it's displayed.
   */
  static async getDashboard({ factoryIds, canViewRates }) {
    const [operational, trends] = await Promise.all([
      this.getOperationalWidgets(factoryIds),
      this.getTrends(factoryIds, { includeFinancial: canViewRates }),
    ]);

    const payload = { operational, trends, scope: { factoryIds: factoryIds || null, financial: canViewRates } };
    if (canViewRates) payload.financial = await this.getFinancialWidgets(factoryIds);
    return payload;
  }
}

module.exports = { DashboardService };
