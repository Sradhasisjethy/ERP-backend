const crypto = require('crypto');
const { searchWhere } = require('../../utils/pagination');
const { Op } = require('sequelize');
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

  static async listPlans(page, limit, { factoryId, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
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

  // --- BR-06..BR-10: Production Entry (casting) ---
  static async listEntries(page, limit, { factoryId, productId, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
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

      for (const bomLine of mixDesign.lines) {
        const mixDesignQty = Number(bomLine.quantityPerUnit) * Number(goodQty);
        const override = materialLineByProductId.get(bomLine.rawMaterialProductId);
        const actualQty = override ? Number(override.actualQty) : mixDesignQty;

        const variancePercent = mixDesignQty > 0 ? (Math.abs(actualQty - mixDesignQty) / mixDesignQty) * 100 : (actualQty > 0 ? 100 : 0);

        // BR-09: any variance at all requires a reason; beyond the factory's
        // configured threshold it's additionally flagged for supervisor approval.
        if (variancePercent > 0 && !(override && override.varianceReason)) {
          throw new ValidationError(
            `Material consumption for ${bomLine.rawMaterialProductId} differs from the mix design (expected ${mixDesignQty}, got ${actualQty}) — a variance reason is required`
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
  static async listWastage(page, limit, { factoryId, productId, stage } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
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
    return sequelize.transaction(async (transaction) => {
      if (lotId) {
        await StockLedgerService.postEntry({
          factoryId: data.factoryId, productId: data.productId, lotId,
          movementType: 'BREAKAGE_OUT', direction: 'OUT', quantity: data.quantity,
          referenceType: 'WastageRecord', referenceId: crypto.randomUUID(), notes: data.reason, transaction,
        });
      }
      const record = await WastageRecord.create({ ...data, lotId: lotId || null }, { transaction });
      return record;
    });
  }
}

module.exports = { ProductionService };
