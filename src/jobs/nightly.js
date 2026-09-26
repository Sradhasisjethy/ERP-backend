const cls = require('cls-hooked');
const { Op } = require('sequelize');
const { NAMESPACE_NAME } = require('../core/tenantContext');
const { Tenant } = require('../api/organization/tenant.model');
const { Factory } = require('../api/factory/factory.model');
const { StockLot } = require('../api/inventory/stockLot.model');
const { Product } = require('../api/products/product.model');
const { Party } = require('../api/parties/party.model');
const { SalesInvoice } = require('../api/invoicing/salesInvoice.model');
const { SalesOrder } = require('../api/sales/salesOrder.model');
const { AgeingService } = require('../api/inventory/ageing.service');
const { ReservationService } = require('../api/inventory/reservation.service');
const { StockLedgerService } = require('../api/inventory/stockLedger.service');
const { LedgerService } = require('../api/ledger/ledger.service');
const { NotificationsService } = require('../api/notifications/notifications.service');
const { getInvoiceAllocatedAmount } = require('../api/payments/payments.service');
const { RefreshToken } = require('../api/auth/refreshToken.model');
const { IdempotencyKey } = require('../api/idempotency/idempotencyKey.model');
const { sequelize } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Scheduled background work (FR-M09-9, FR-M22-4, FR-M24-5, AC-5.2).
 *
 * Every job here is idempotent and safe to re-run (D2): promotion is a
 * conditional UPDATE, classification recomputes from scratch, and alerts are
 * deduplicated by NotificationsService. That means a missed night or a double
 * run causes no damage — which matters because this runs unattended.
 *
 * Jobs run per tenant inside a CLS context, because the models auto-scope
 * every query to the tenant in that context.
 */

const runForTenant = (tenantId, fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

const daysBetween = (from, to) => {
  const d = (x) => {
    const v = new Date(x);
    return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  };
  return Math.floor((d(to) - d(from)) / 86400000);
};

/** BR-08 / FR-M09-9: CURING -> AVAILABLE once the curing period has elapsed. */
const promoteCuredLots = async () => {
  const factories = await Factory.findAll({ attributes: ['id'] });
  const alerts = [];

  // Each factory is isolated. One plant's data or configuration must not stop
  // every other plant releasing its cured stock: a missing QC_HOLD enum value
  // at a single QC-enabled factory used to abort the whole run, so no lot
  // anywhere left CURING and nothing could be dispatched the next morning.
  const failures = [];

  for (const factory of factories) {
    try {
      const due = await StockLot.findAll({
        where: { factoryId: factory.id, status: 'CURING' },
        include: [{ model: Product, as: 'product', attributes: ['name'] }],
      });

      await StockLedgerService.promoteEligibleLots(factory.id);

      for (const lot of due) {
        await lot.reload();
        if (lot.status !== 'AVAILABLE') continue;
        alerts.push({
          type: 'CURING_COMPLETE',
          severity: 'LOW',
          title: 'Curing complete',
          message: `Lot ${lot.lotNumber} (${lot.product?.name || 'product'}) has finished curing and is now available`,
          factoryId: factory.id,
          entityType: 'StockLot',
          entityId: lot.id,
          dedupeKey: `CURING_COMPLETE:${lot.id}`,
        });
      }
    } catch (error) {
      failures.push(`${factory.id}: ${error.message}`);
    }
  }

  const raised = await NotificationsService.raiseMany(alerts);

  // Raised first so the promotions that did succeed are reported, then thrown
  // so the run is still recorded as failed — a factory silently not promoting
  // is worse than a red job.
  if (failures.length) {
    throw new Error(
      `promoteCuredLots failed for ${failures.length} of ${factories.length} factories — ${failures.join('; ')}`
    );
  }

  return { promoted: alerts.length, ...raised };
};

/** FR-M22-4 + AC-13.3: reclassify open lots and alert on newly near-dead ones. */
const classifyAgeing = async () => {
  const result = await AgeingService.reclassifyAll();

  const alerts = result.newlyNearDead.map(({ lot, daysToDead }) => ({
    type: 'NEAR_DEAD_STOCK',
    severity: 'MEDIUM',
    title: 'Stock approaching dead-stock threshold',
    message: `Lot ${lot.lotNumber} will become dead stock in ${daysToDead} days`,
    factoryId: lot.factoryId,
    entityType: 'StockLot',
    entityId: lot.id,
    metadata: { daysToDead, ageDays: lot.ageDays, quantity: Number(lot.qtyAvailable) },
    dedupeKey: `NEAR_DEAD_STOCK:${lot.id}`,
  }));

  // Anything already dead gets its own standing alert.
  const deadLots = await StockLot.findAll({
    where: { ageingClass: 'DEAD', qtyAvailable: { [Op.gt]: 0 }, status: 'AVAILABLE' },
    include: [{ model: Product, as: 'product', attributes: ['name'] }],
    limit: 500,
  });
  for (const lot of deadLots) {
    alerts.push({
      type: 'DEAD_STOCK',
      severity: 'HIGH',
      title: 'Dead stock',
      message: `Lot ${lot.lotNumber} (${lot.product?.name || 'product'}) has been idle ${lot.ageDays} days`,
      factoryId: lot.factoryId,
      entityType: 'StockLot',
      entityId: lot.id,
      metadata: { ageDays: lot.ageDays, quantity: Number(lot.qtyAvailable) },
      dedupeKey: `DEAD_STOCK:${lot.id}`,
    });
  }

  const raised = await NotificationsService.raiseMany(alerts);
  return { ...result, newlyNearDead: result.newlyNearDead.length, ...raised };
};

/** FR-M24-2: receivables past their credit days. */
const alertOverdueReceivables = async () => {
  const invoices = await SalesInvoice.findAll({
    where: { status: 'POSTED' },
    include: [{ model: Party, as: 'customer', attributes: ['name', 'creditAgeingDays'] }],
    limit: 1000,
  });

  const today = new Date();
  const alerts = [];

  for (const invoice of invoices) {
    const allocated = await getInvoiceAllocatedAmount('SALES', invoice.id);
    const outstandingPaise = Number(invoice.totalPaise) - allocated;
    if (outstandingPaise <= 0) continue;

    const creditDays = Number(invoice.customer?.creditAgeingDays || 0) || 30;
    const daysOverdue = daysBetween(invoice.invoiceDate, today) - creditDays;
    if (daysOverdue <= 0) continue;

    alerts.push({
      type: 'OVERDUE_RECEIVABLE',
      severity: daysOverdue > 90 ? 'HIGH' : 'MEDIUM',
      title: 'Overdue receivable',
      // BR-27: the amount stays out of the prose and lives in metadata,
      // where the controller can mask it.
      message: `Invoice ${invoice.invoiceNumber} for ${invoice.customer?.name} is ${daysOverdue} days overdue`,
      factoryId: invoice.factoryId,
      entityType: 'SalesInvoice',
      entityId: invoice.id,
      metadata: { daysOverdue, outstandingPaise },
      dedupeKey: `OVERDUE_RECEIVABLE:${invoice.id}`,
    });
  }

  return NotificationsService.raiseMany(alerts);
};

/** FR-M24-2: confirmed orders whose expected delivery date has passed. */
const alertLateOrders = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const late = await SalesOrder.findAll({
    where: {
      status: { [Op.in]: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] },
      expectedDeliveryDate: { [Op.lt]: today },
    },
    include: [{ model: Party, as: 'customer', attributes: ['name'] }],
    limit: 500,
  });

  return NotificationsService.raiseMany(
    late.map((order) => ({
      type: 'ORDER_PAST_DELIVERY_DATE',
      severity: 'MEDIUM',
      title: 'Order past its delivery date',
      message: `Order ${order.orderNumber} for ${order.customer?.name} passed its expected delivery date`,
      factoryId: order.factoryId,
      entityType: 'SalesOrder',
      entityId: order.id,
      metadata: { expectedDeliveryDate: order.expectedDeliveryDate },
      dedupeKey: `ORDER_PAST_DELIVERY_DATE:${order.id}`,
    }))
  );
};

/** FR-M07-4: reservations sitting unfulfilled for too long. */
const alertStaleReservations = async (staleDays = 30) => {
  const stale = await ReservationService.listStale(staleDays);
  return NotificationsService.raiseMany(
    stale.map((reservation) => ({
      type: 'STALE_RESERVATION',
      severity: 'LOW',
      title: 'Stale stock reservation',
      message: `Stock has been held on lot ${reservation.lot?.lotNumber} for more than ${staleDays} days`,
      factoryId: reservation.factoryId,
      entityType: 'StockReservation',
      entityId: reservation.id,
      metadata: { quantity: Number(reservation.quantity) },
      dedupeKey: `STALE_RESERVATION:${reservation.id}`,
    }))
  );
};

/** BR-21: a factory whose cash account has gone negative. */
const alertNegativeCash = async () => {
  const factories = await Factory.findAll({ attributes: ['id', 'name'] });
  const cashAccount = await LedgerService.getOrCreateSystemAccount('CASH');
  const alerts = [];

  for (const factory of factories) {
    const balance = await LedgerService.getAccountBalance(cashAccount.id, factory.id);
    if (balance >= 0) continue;
    alerts.push({
      type: 'NEGATIVE_CASH',
      severity: 'CRITICAL',
      title: 'Negative cash balance',
      message: `Cash balance at ${factory.name} has gone negative`,
      factoryId: factory.id,
      entityType: 'Factory',
      entityId: factory.id,
      metadata: { balancePaise: balance },
      dedupeKey: `NEGATIVE_CASH:${factory.id}`,
    });
  }

  return NotificationsService.raiseMany(alerts);
};

/**
 * AC-5.2 / D2: the ledger is authoritative. Any drift between it and the
 * per-lot running quantity is a bug, so it alerts loudly rather than
 * self-healing silently — an automatic rebuild would hide the cause.
 */
const checkLedgerConsistency = async () => {
  const { checked, discrepancies } = await StockLedgerService.reconcileLedgerVsBalances();
  if (!discrepancies.length) return { checked, discrepancies: 0 };

  logger.error({ message: 'Stock ledger/balance drift detected', count: discrepancies.length, discrepancies });

  await NotificationsService.raiseMany(
    discrepancies.map((d) => ({
      type: 'LEDGER_BALANCE_DRIFT',
      severity: 'CRITICAL',
      title: 'Stock ledger does not match balance',
      message: `Lot ${d.lotNumber}: ledger says ${d.ledgerQty}, balance says ${d.balanceQty}`,
      factoryId: d.factoryId,
      entityType: 'StockLot',
      entityId: d.lotId,
      metadata: { ledgerQty: d.ledgerQty, balanceQty: d.balanceQty, drift: d.drift },
      // Re-alert when the drift *changes*, not once and never again — the
      // number moving means something new went wrong.
      dedupeKey: `LEDGER_BALANCE_DRIFT:${d.lotId}:${d.drift}`,
    }))
  );

  return { checked, discrepancies: discrepancies.length };
};

const JOBS = [
  ['promoteCuredLots', promoteCuredLots],
  ['classifyAgeing', classifyAgeing],
  ['alertOverdueReceivables', alertOverdueReceivables],
  ['alertLateOrders', alertLateOrders],
  ['alertStaleReservations', alertStaleReservations],
  ['alertNegativeCash', alertNegativeCash],
  ['checkLedgerConsistency', checkLedgerConsistency],
];

/**
 * Runs the whole nightly batch for every active tenant. One job failing is
 * logged and does not abort the rest — a broken ageing calculation must not
 * stop curing promotion, which affects what can be dispatched tomorrow.
 */
/**
 * One runner at a time, across every instance.
 *
 * The scheduler lives inside each API process and remembers "already ran
 * today" in a module variable, so two instances behind a load balancer would
 * each run the nightly batch — promoting lots twice, raising every alert
 * twice. A Postgres advisory lock is the cheapest fence there is: no table,
 * no Redis, and it releases itself if the holder dies.
 *
 * Session-level rather than transaction-level on purpose: the run takes a
 * while, and holding a transaction open across it would trip
 * idle_in_transaction_session_timeout and pin a pool slot. So it borrows one
 * raw connection, locks on that, and gives it back at the end.
 */
const NIGHTLY_LOCK_KEY = 20260925;

const withNightlyLock = async (fn) => {
  const connection = await sequelize.connectionManager.getConnection({ type: 'write' });
  try {
    const { rows } = await connection.query('SELECT pg_try_advisory_lock($1) AS held', [NIGHTLY_LOCK_KEY]);
    if (!rows[0].held) {
      logger.info({ message: 'Nightly jobs skipped — another instance holds the lock' });
      return { skipped: 'another instance is running the nightly jobs' };
    }
    try {
      return await fn();
    } finally {
      await connection.query('SELECT pg_advisory_unlock($1)', [NIGHTLY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    sequelize.connectionManager.releaseConnection(connection);
  }
};

/**
 * Rows that only ever accumulate: a refresh token per login, an idempotency
 * key per retried request. Neither had a pruning path, so both tables grew
 * for ever. Expired tokens are useless by definition; an idempotency key
 * exists to catch a retry seconds later, not a day later.
 */
const pruneExpiredRows = async () => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [tokens, keys] = await Promise.all([
    RefreshToken.destroy({ where: { expiresAt: { [Op.lt]: now } } }),
    IdempotencyKey.destroy({ where: { createdAt: { [Op.lt]: dayAgo } } }),
  ]);
  return { expiredRefreshTokens: tokens, staleIdempotencyKeys: keys };
};

const runNightly = ({ tenantId } = {}) => withNightlyLock(() => runNightlyUnlocked({ tenantId }));

const runNightlyUnlocked = async ({ tenantId } = {}) => {
  const tenants = tenantId
    ? [{ id: tenantId }]
    : await Tenant.findAll({ where: { status: 'active' }, attributes: ['id'] });

  const report = {};

  for (const tenant of tenants) {
    report[tenant.id] = {};
    for (const [name, job] of JOBS) {
      try {
        report[tenant.id][name] = await runForTenant(tenant.id, job);
      } catch (error) {
        logger.error({ message: `Nightly job "${name}" failed`, tenantId: tenant.id, error: error.message, stack: error.stack });
        report[tenant.id][name] = { error: error.message };
        await runForTenant(tenant.id, () =>
          NotificationsService.raise({
            type: 'JOB_FAILED',
            severity: 'HIGH',
            title: 'Scheduled job failed',
            message: `The "${name}" job failed: ${error.message}`,
            dedupeKey: `JOB_FAILED:${name}:${new Date().toISOString().slice(0, 10)}`,
          })
        ).catch(() => {});
      }
    }
  }

  // Cross-tenant housekeeping, once per run rather than once per tenant. The
  // models are unscoped here (no CLS tenant), which is what a prune wants.
  try {
    report.housekeeping = await pruneExpiredRows();
  } catch (error) {
    logger.error({ message: 'Nightly housekeeping failed', error: error.message });
    report.housekeeping = { error: error.message };
  }

  return report;
};

module.exports = {
  pruneExpiredRows,
  withNightlyLock,
  NIGHTLY_LOCK_KEY,
  runNightly,
  promoteCuredLots,
  classifyAgeing,
  alertOverdueReceivables,
  alertLateOrders,
  alertStaleReservations,
  alertNegativeCash,
  checkLedgerConsistency,
  runForTenant,
};
