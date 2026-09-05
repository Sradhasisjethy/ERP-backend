const crypto = require('crypto');
const { searchWhere } = require('../../utils/pagination');
const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../../config/database');
const { ProductionPlan } = require('./productionPlan.model');
const { ProductionPlanLine } = require('./productionPlanLine.model');
const { ProductionEntry } = require('./productionEntry.model');
const { MaterialConsumption } = require('./materialConsumption.model');
const { WastageRecord } = require('./wastageRecord.model');
const { Product } = require('../products/product.model');
const { MixDesign } = require('../products/mixDesign.model');
const { MixDesignLine } = require('../products/mixDesignLine.model');
const { BomService } = require('../products/bom.service');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { StockLot } = require('../inventory/stockLot.model');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { ACTIVE_ORDER_STATUSES } = require('../sales/sales.service');
const { getUserId } = require('../../core/tenantContext');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class ProductionService {
  // --- BR-12: Production Plan proposal ---
  static async generateProposal(factoryId, planDate) {
    return sequelize.transaction(async (transaction) => {
      // Every product with an open (uncommitted) sales order quantity at this factory.
      const openLines = await SalesOrderLine.findAll({
        attributes: ['productId', 'orderedQty', 'dispatchedQty'],
        include: [{ model: SalesOrder, as: 'salesOrder', attributes: [], where: { factoryId, status: { [Op.in]: ACTIVE_ORDER_STATUSES } }, required: true }],
        transaction,
      });

      const openQtyByProduct = new Map();
      for (const line of openLines) {
        const net = Number(line.orderedQty) - Number(line.dispatchedQty);
        openQtyByProduct.set(line.productId, (openQtyByProduct.get(line.productId) || 0) + net);
      }

      const plan = await ProductionPlan.create({ factoryId, planDate, status: 'PROPOSED' }, { transaction });
      const lines = [];

      for (const [productId, totalOrdered] of openQtyByProduct.entries()) {
        const stockBalance = await StockLedgerService.getStockBalance(factoryId, productId, transaction);
        const requiredQty = totalOrdered - stockBalance;
        if (requiredQty > 0) {
          lines.push(await ProductionPlanLine.create({ productionPlanId: plan.id, productId, requiredQty }, { transaction }));
        }
      }

      return this.getPlan(plan.id, transaction);
    });
  }

  static async listPlans(page, limit, { status, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['planNumber']));
    return ProductionPlan.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: ProductionPlanLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['planDate', 'DESC']],
    });
  }

  static async getPlan(id, transaction) {
    const plan = await ProductionPlan.findByPk(id, {
      include: [{ model: ProductionPlanLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      transaction,
    });
    if (!plan) throw new NotFoundError('Production plan not found');
    return plan;
  }

  // BR-12: "a human confirms it" — lines can be adjusted before confirming.
  static async confirmPlan(id, lineAdjustments = []) {
    const plan = await this.getPlan(id);
    if (plan.status !== 'PROPOSED') throw new ValidationError('Only a PROPOSED plan can be confirmed');

    return sequelize.transaction(async (transaction) => {
      const adjustmentByLineId = new Map(lineAdjustments.map((a) => [a.lineId, a.confirmedQty]));
      for (const line of plan.lines) {
        const confirmedQty = adjustmentByLineId.has(line.id) ? adjustmentByLineId.get(line.id) : line.requiredQty;
        await line.update({ confirmedQty }, { transaction });
      }
      await plan.update({ status: 'CONFIRMED' }, { transaction });
      return this.getPlan(id, transaction);
    });
  }

  /**
   * Everything a production sheet needs: the plan, its lines, and for each one
   * the mix design in force ON THE PLAN DATE — the same resolution the posting
   * code uses, so the paper the crew batches from cannot disagree with what
   * the system will expect them to have consumed.
   */
  static async getSheetData(planId) {
    const plan = await this.getPlan(planId);
    if (plan.status !== 'CONFIRMED') {
      throw new ValidationError('Only a confirmed plan can be printed as a production sheet — confirm the quantities first');
    }

    const lines = [];
    for (const line of plan.lines) {
      let mixDesign = null;
      try {
        mixDesign = await BomService.resolveForDate(line.productId, plan.planDate);
      } catch {
        // No effective recipe. The sheet says so in red rather than failing the
        // whole print — the other items on the plan can still be batched.
        mixDesign = null;
      }

      const produced = await ProductionEntry.sum('goodQty', {
        where: { productionPlanLineId: line.id, status: 'POSTED' },
      });
      const target = Number(line.confirmedQty ?? line.requiredQty);
      const producedQty = Number(produced || 0);

      lines.push({
        ...line.toJSON(),
        mixDesign: mixDesign ? mixDesign.toJSON() : null,
        producedQty,
        remainingQty: Math.max(0, Number((target - producedQty).toFixed(4))),
      });
    }

    return { plan, lines };
  }

  // --- BR-06..BR-10: Production Entry (casting) ---
  static async listEntries(page, limit, { productId, status, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (productId) where.productId = productId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['entryNumber']));
    return ProductionEntry.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: Product, as: 'product' },
        { model: MaterialConsumption, as: 'consumptions', include: [{ model: Product, as: 'rawMaterial' }] },
      ],
      order: [['productionDate', 'DESC']],
    });
  }

  static async getEntry(id) {
    const entry = await ProductionEntry.findByPk(id, {
      include: [
        { model: Product, as: 'product' },
        { model: StockLot, as: 'lot' },
        { model: MaterialConsumption, as: 'consumptions', include: [{ model: Product, as: 'rawMaterial' }] },
      ],
    });
    if (!entry) throw new NotFoundError('Production entry not found');
    return entry;
  }

  static async createEntry({ factoryId, productId, productionDate, goodQty, rejectedQty, productionPlanLineId, materialLines }) {
    if (Number(goodQty) <= 0) throw new ValidationError('goodQty must be positive');

    return sequelize.transaction(async (transaction) => {
      const product = await Product.findByPk(productId, { transaction });
      if (!product) throw new NotFoundError('Product not found');

      // BR-06 / FR-M03-8: consume per the mix design in force on the
      // PRODUCTION DATE, not whichever version happens to be active now.
      // Backdating an entry must reproduce the recipe that was actually used,
      // which is what keeps historical entries explainable (AC-2.1).
      const mixDesign = await BomService.resolveForDate(productId, productionDate, transaction);

      // What this run actually consumes, in the units the materials are stocked
      // in. BomService.explode applies the wastage allowance and converts each
      // BOM unit into the material's own — a line written as "380 KG" against
      // aggregate stocked in CUM must consume 0.2584 CUM per unit, not 380.
      //
      // Production used to recompute this itself as `quantityPerUnit * goodQty`,
      // which did neither. That compared kilograms against cubic metres when
      // checking availability — blocking runs there was ample material for —
      // and, where the units happened to agree, silently under-consumed by
      // exactly the wastage percentage the recipe declared.
      const { requirements } = await BomService.explode(mixDesign.id, goodQty, transaction);
      const requiredByProductId = new Map(requirements.map((r) => [r.rawMaterialProductId, Number(r.quantity)]));

      const factory = await Factory.findByPk(factoryId, { transaction });
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PRODUCTION_ENTRY', {
        factoryId,
        financialYearId,
        prefix: 'PE',
        transaction,
      });

      // ProductionEntry and its StockLot each reference the other, so the
      // entry's id is minted up front rather than left to the DB default.
      const entryId = crypto.randomUUID();

      const lot = await StockLedgerService.createLot({
        factoryId,
        productId,
        lotNumber: documentNumber,
        originType: 'PRODUCTION',
        originId: entryId,
        originDate: productionDate,
        curingDaysOverride: product.curingDays,
        quantity: goodQty,
        transaction,
      });

      await StockLedgerService.postEntry({
        factoryId, productId, lotId: lot.id,
        movementType: 'PRODUCTION_IN', direction: 'IN', quantity: goodQty,
        referenceType: 'ProductionEntry', referenceId: entryId, transaction,
      });

      const entry = await ProductionEntry.create(
        {
          id: entryId,
          factoryId,
          entryNumber: documentNumber,
          productId,
          mixDesignId: mixDesign.id,
          productionPlanLineId: productionPlanLineId || null,
          productionDate,
          goodQty,
          rejectedQty: rejectedQty || 0,
          curingDays: product.curingDays,
          lotId: lot.id,
        },
        { transaction }
      );

      const materialLineByProductId = new Map((materialLines || []).map((m) => [m.rawMaterialProductId, m]));

      // Names for every raw material on the recipe, fetched once. Without this
      // both the shortage error below and the variance error further down can
      // only name a product by its UUID, which tells a plant operator nothing.
      const rawMaterialIds = mixDesign.lines.map((l) => l.rawMaterialProductId);
      const rawMaterials = await Product.findAll({ where: { id: { [Op.in]: rawMaterialIds } }, transaction });
      const nameOf = new Map(rawMaterials.map((p) => [p.id, p.name || p.code || p.id]));

      // PRD-03: check every material BEFORE consuming any of them.
      //
      // Previously the first shortage threw from inside consumeFifo partway
      // through the loop. The transaction rolled back so the data stayed
      // correct, but the operator learned about exactly one missing material
      // per attempt and had to resubmit to discover the next one. Collect the
      // whole picture and report it in a single error, the way sales orders
      // already compute a shortfall up front.
      //
      // Skipped when the factory permits negative stock, since there is then no
      // shortage to report, and for lines pinned to a specific lot, which
      // postEntry validates against that lot directly.
      if (!factory.allowNegativeStock) {
        const shortages = [];
        for (const bomLine of mixDesign.lines) {
          const override = materialLineByProductId.get(bomLine.rawMaterialProductId);
          if (override && override.overrideLotId) continue;
          const requiredQty = override
            ? Number(override.actualQty)
            : requiredByProductId.get(bomLine.rawMaterialProductId) || 0;
          if (requiredQty <= 0) continue;

          const available = await StockLedgerService.getStockBalance(
            factoryId, bomLine.rawMaterialProductId, transaction
          );
          if (available < requiredQty) {
            shortages.push(
              `${nameOf.get(bomLine.rawMaterialProductId)}: need ${requiredQty}, available ${available} (short ${Number((requiredQty - available).toFixed(4))})`
            );
          }
        }
        if (shortages.length) {
          throw new ValidationError(
            `Not enough raw material to produce ${goodQty} of ${product.name || product.code}. ` +
              `${shortages.length} material${shortages.length === 1 ? '' : 's'} short — ${shortages.join('; ')}.`
          );
        }
      }

      for (const bomLine of mixDesign.lines) {
        const mixDesignQty = requiredByProductId.get(bomLine.rawMaterialProductId) || 0;
        const override = materialLineByProductId.get(bomLine.rawMaterialProductId);
        const actualQty = override ? Number(override.actualQty) : mixDesignQty;

        const variancePercent = mixDesignQty > 0 ? (Math.abs(actualQty - mixDesignQty) / mixDesignQty) * 100 : (actualQty > 0 ? 100 : 0);

        // BR-09: any variance at all requires a reason; beyond the factory's
        // configured threshold it's additionally flagged for supervisor approval.
        if (variancePercent > 0 && !(override && override.varianceReason)) {
          throw new ValidationError(
            `Material consumption for ${nameOf.get(bomLine.rawMaterialProductId)} differs from the mix design (expected ${mixDesignQty}, got ${actualQty}) — a variance reason is required`
          );
        }
        const requiresApproval = variancePercent > Number(factory.varianceThresholdPercent);

        await StockLedgerService.consumeFifo({
          factoryId, productId: bomLine.rawMaterialProductId, quantity: actualQty,
          movementType: 'PRODUCTION_OUT', referenceType: 'ProductionEntry', referenceId: entryId,
          overrideLotId: override && override.overrideLotId, overrideReason: override && override.overrideLotReason,
          transaction,
        });

        await MaterialConsumption.create(
          {
            productionEntryId: entryId,
            rawMaterialProductId: bomLine.rawMaterialProductId,
            mixDesignQty,
            actualQty,
            variancePercent,
            varianceReason: override ? override.varianceReason : null,
            requiresApproval,
          },
          { transaction }
        );
      }

      return this.getEntry(entryId);
    });
  }

  /**
   * BR-33: cancellation preserves the record and its number — never deletes.
   *
   * A casting run is the only document in the system that moves stock twice:
   * raw material out, finished goods in. Cancelling therefore has to reverse
   * BOTH legs, and `reverseEntry` does that correctly by construction — it
   * posts the opposite direction against the SAME lot the original touched, so
   * raw material returns to the exact lots FIFO drew it from rather than to an
   * arbitrary one.
   */
  static async cancelEntry(id, reason) {
    if (!reason || !String(reason).trim()) throw new ValidationError('A cancellation reason is required');

    const entry = await this.getEntry(id);
    if (entry.status !== 'POSTED') {
      throw new ValidationError(`Only a POSTED production entry can be cancelled (current status: ${entry.status})`);
    }

    return sequelize.transaction(async (transaction) => {
      // Lock the produced lot before inspecting it, so a dispatch cannot draw
      // it down between the guard below and the reversal.
      const lot = await StockLot.findOne({
        where: { id: entry.lotId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lot) throw new NotFoundError('The stock lot for this production entry no longer exists');

      // The output must still be intact. Reversing the PRODUCTION_IN takes
      // goodQty back out of this lot; if any of it has already been dispatched,
      // transferred, wasted or issued to a contractor, that would either fail
      // deep inside postEntry with a confusing message or (on a factory with
      // allowNegativeStock) quietly push the lot negative. Refuse up front and
      // say what actually happened instead.
      const consumedFromLot = Number(entry.goodQty) - Number(lot.qtyAvailable);
      if (consumedFromLot > 1e-6) {
        throw new ValidationError(
          `Cannot cancel this production entry: ${Number(consumedFromLot.toFixed(4))} of its ${Number(entry.goodQty)} unit output has already left lot ${lot.lotNumber}. ` +
            'Cancel or reverse those movements first, or record the correction as a stock adjustment.'
        );
      }
      if (!['AVAILABLE', 'CURING'].includes(lot.status)) {
        throw new ValidationError(
          `Cannot cancel this production entry: its lot ${lot.lotNumber} is ${lot.status}, so the output is no longer held at this factory.`
        );
      }

      const movements = await StockLedgerEntry.findAll({
        where: {
          referenceType: 'ProductionEntry',
          referenceId: entry.id,
          movementType: { [Op.in]: ['PRODUCTION_IN', 'PRODUCTION_OUT'] },
        },
        transaction,
      });
      for (const movement of movements) {
        await StockLedgerService.reverseEntry(movement.id, reason, transaction);
      }

      // postEntry flips a drained AVAILABLE lot to CONSUMED on its own, but a
      // lot still CURING keeps that status and would later be "promoted" to
      // AVAILABLE holding nothing. Retire it explicitly so no screen offers an
      // empty lot from a cancelled run.
      await lot.reload({ transaction });
      if (Number(lot.qtyAvailable) <= 1e-6) {
        await lot.update({ status: 'CONSUMED' }, { transaction });
      }

      await entry.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getEntry(id);
    });
  }

  /**
   * Production orders — the shop floor's work list.
   *
   * Deliberately NOT a new entity. This plant already models the work twice:
   * a ProductionPlan proposes what is needed, and a ProductionEntry records
   * what was actually cast. A confirmed plan LINE is therefore already the
   * order — "make 300 slabs" — and inventing a third document between them
   * would duplicate the concept and give two places to look for one answer.
   *
   * What was genuinely missing is fulfilment: nothing told you how much of a
   * confirmed line had actually been produced. That is computed here from the
   * entries that reference the line.
   */
  static async listOrders(page, limit, { status, productId, search, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;

    const planWhere = { ...baseWhere, status: 'CONFIRMED' };
    if (search) Object.assign(planWhere, searchWhere(search, ['planNumber']));

    const lineWhere = {};
    if (productId) lineWhere.productId = productId;

    const { rows, count } = await ProductionPlanLine.findAndCountAll({
      where: lineWhere,
      limit,
      offset,
      include: [
        { model: Product, as: 'product' },
        { model: ProductionPlan, as: 'productionPlan', where: planWhere, required: true },
      ],
      order: [[{ model: ProductionPlan, as: 'productionPlan' }, 'planDate', 'DESC']],
    });

    // One grouped query rather than one per row.
    const lineIds = rows.map((r) => r.id);
    const producedByLine = new Map();
    if (lineIds.length) {
      const totals = await ProductionEntry.findAll({
        attributes: [
          'productionPlanLineId',
          [fn('COALESCE', fn('SUM', col('goodQty')), 0), 'produced'],
        ],
        where: { productionPlanLineId: { [Op.in]: lineIds }, status: 'POSTED' },
        group: ['productionPlanLineId'],
        raw: true,
      });
      totals.forEach((t) => producedByLine.set(t.productionPlanLineId, Number(t.produced)));
    }

    const decorated = rows.map((line) => {
      const target = Number(line.confirmedQty ?? line.requiredQty);
      const producedQty = producedByLine.get(line.id) || 0;
      const remainingQty = Math.max(0, Number((target - producedQty).toFixed(4)));
      return {
        ...line.toJSON(),
        targetQty: target,
        producedQty,
        remainingQty,
        // NOT_STARTED / IN_PROGRESS / COMPLETE, derived rather than stored, so
        // it can never drift from the entries it describes.
        fulfilmentStatus: producedQty <= 0 ? 'NOT_STARTED' : remainingQty > 0 ? 'IN_PROGRESS' : 'COMPLETE',
      };
    });

    const filtered = status ? decorated.filter((d) => d.fulfilmentStatus === status) : decorated;
    return { rows: filtered, count: status ? filtered.length : count };
  }

  /**
   * Material actually consumed, across every run — the shop-floor question
   * "where did the cement go this month?".
   *
   * The rows have existed since production was written but were only ever
   * reachable nested inside a single entry, or filtered down to the ones
   * awaiting variance approval. This lists them in their own right.
   */
  static async listConsumptions(page, limit, { productId, rawMaterialProductId, requiresApproval, search, factoryId } = {}) {
    const offset = (page - 1) * limit;

    const where = {};
    if (rawMaterialProductId) where.rawMaterialProductId = rawMaterialProductId;
    if (requiresApproval !== undefined) where.requiresApproval = requiresApproval;

    // entryNumber and the finished product both live on the joined entry, so
    // the factory scope and the search clause belong on that include.
    const entryWhere = {
      ...(factoryId ? { factoryId } : {}),
      ...(productId ? { productId } : {}),
      ...(search ? searchWhere(search, ['entryNumber']) : {}),
    };

    return MaterialConsumption.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: Product, as: 'rawMaterial' },
        {
          model: ProductionEntry,
          as: 'productionEntry',
          include: [{ model: Product, as: 'product' }],
          where: Object.keys(entryWhere).length ? entryWhere : undefined,
          required: true,
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  static async approveVariance(consumptionId) {
    const consumption = await MaterialConsumption.findByPk(consumptionId);
    if (!consumption) throw new NotFoundError('Material consumption record not found');
    if (!consumption.requiresApproval) throw new ValidationError('This consumption does not require approval');
    return consumption.update({ approvedBy: getUserId() || null, approvedAt: new Date() });
  }

  static async listPendingApprovals(page, limit, { factoryId, search } = {}) {
    const offset = (page - 1) * limit;
    // The searchable field (entryNumber) lives on the joined ProductionEntry,
    // not on MaterialConsumption, so the search clause goes on that include.
    const entryWhere = { ...(factoryId ? { factoryId } : {}), ...(search ? searchWhere(search, ['entryNumber']) : {}) };
    return MaterialConsumption.findAndCountAll({
      where: { requiresApproval: true, approvedBy: null },
      limit,
      offset,
      include: [
        { model: Product, as: 'rawMaterial' },
        {
          model: ProductionEntry, as: 'productionEntry',
          include: [{ model: Product, as: 'product' }],
          where: Object.keys(entryWhere).length ? entryWhere : undefined,
          required: !!Object.keys(entryWhere).length,
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  // --- M11: Wastage ---
  static async listWastage(page, limit, { productId, stage , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (productId) where.productId = productId;
    if (stage) where.stage = stage;

    return WastageRecord.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Product, as: 'product' }, { model: StockLot, as: 'lot' }],
      order: [['recordedDate', 'DESC']],
    });
  }

  static async createWastage({ lotId, ...data }) {
    // WST-02: wastage without a lot used to write the record and move no stock
    // at all, so a breakage report and the stock ledger silently disagreed and
    // only reconciled at stock-take. Wastage is by definition stock that no
    // longer exists, so the lot is now required.
    if (!lotId) {
      throw new ValidationError('A stock lot is required to record wastage, so the quantity can be taken out of stock');
    }

    return sequelize.transaction(async (transaction) => {
      // WST-01: the id is minted here and used for BOTH the ledger entry and
      // the record, mirroring createEntry above. It was previously a throwaway
      // crypto.randomUUID() passed only to the ledger, so every BREAKAGE_OUT
      // movement carried referenceType 'WastageRecord' and a referenceId that
      // matched no row in that table — stock left the building and the ledger
      // could not say why.
      const recordId = crypto.randomUUID();

      await StockLedgerService.postEntry({
        factoryId: data.factoryId, productId: data.productId, lotId,
        movementType: 'BREAKAGE_OUT', direction: 'OUT', quantity: data.quantity,
        referenceType: 'WastageRecord', referenceId: recordId, notes: data.reason, transaction,
      });

      return WastageRecord.create({ ...data, id: recordId, lotId }, { transaction });
    });
  }
}

module.exports = { ProductionService };
