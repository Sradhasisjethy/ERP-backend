const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { searchWhere, toOrder } = require('../../utils/pagination');
const { QualityInspection } = require('./qualityInspection.model');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');

const SORTABLE = ['inspectionNumber', 'inspectionDate', 'inspectionType', 'result', 'createdAt'];

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

/**
 * QC-01 — inspection records and the lot release decision they gate.
 *
 * The release rule in one line: a lot only leaves QC_HOLD when someone records
 * a passing FINAL inspection against it. Nothing promotes it on a timer, which
 * is the whole point — the curing clock says the concrete is old enough, and a
 * test says it is strong enough, and only the second is a quality statement.
 */
class QualityService {
  /**
   * Whether a lot of this product, produced at this factory, must be tested
   * before it can be sold. Both switches default off, so a plant that does not
   * work this way sees no change at all.
   */
  static async isHoldRequired(factoryId, productId, transaction) {
    const [factory, product] = await Promise.all([
      Factory.findByPk(factoryId, { transaction }),
      Product.findByPk(productId, { transaction }),
    ]);
    return Boolean(factory && factory.qcHoldEnabled && product && product.qcRequired);
  }

  static async listInspections(page, limit, { inspectionType, result, productId, lotId, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (inspectionType) where.inspectionType = inspectionType;
    if (result) where.result = result;
    if (productId) where.productId = productId;
    if (lotId) where.lotId = lotId;
    if (search) Object.assign(where, searchWhere(search, ['inspectionNumber', 'sampleRef']));

    return QualityInspection.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: Product, as: 'product' },
        { model: StockLot, as: 'lot' },
      ],
      order: toOrder(sortBy, sortDir, SORTABLE, [['inspectionDate', 'DESC']]),
    });
  }

  static async getInspection(id) {
    const inspection = await QualityInspection.findByPk(id, {
      include: [
        { model: Product, as: 'product' },
        { model: StockLot, as: 'lot' },
      ],
    });
    if (!inspection) throw new NotFoundError('Quality inspection not found');
    return inspection;
  }

  /**
   * Raises an inspection. A result may be supplied straight away (a slump test
   * read at the mixer) or left PENDING to be recorded later (a cube crushed at
   * 28 days) — both are ordinary, so neither is the special case.
   */
  static async createInspection(data) {
    return sequelize.transaction(async (transaction) => {
      const product = await Product.findByPk(data.productId, { transaction });
      if (!product) throw new NotFoundError('Product not found');

      let lot = null;
      if (data.lotId) {
        lot = await StockLot.findOne({ where: { id: data.lotId, factoryId: data.factoryId }, transaction });
        if (!lot) throw new NotFoundError('Stock lot not found for this factory');
        if (String(lot.productId) !== String(data.productId)) {
          throw new ValidationError('That stock lot holds a different product than the one being inspected');
        }
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('QUALITY_INSPECTION', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'QC',
        transaction,
      });

      const inspection = await QualityInspection.create(
        {
          ...data,
          inspectionNumber: documentNumber,
          result: data.result || 'PENDING',
          quantityRejected: data.quantityRejected || 0,
          recordedOn: data.result && data.result !== 'PENDING' ? new Date() : null,
          inspectedBy: data.result && data.result !== 'PENDING' ? getUserId() || null : null,
        },
        { transaction }
      );

      if (inspection.result !== 'PENDING') {
        await this._applyVerdict(inspection, lot, transaction);
      }

      return this.getInspection(inspection.id);
    });
  }

  /**
   * Records the verdict on a pending test and applies it to the lot.
   */
  static async recordResult(id, { result, testedValue, requiredValue, unitLabel, quantityRejected, remarks }) {
    if (!['PASS', 'FAIL'].includes(result)) {
      throw new ValidationError('Result must be PASS or FAIL');
    }

    const inspection = await this.getInspection(id);
    if (inspection.result !== 'PENDING') {
      throw new ValidationError(
        `This inspection has already been recorded as ${inspection.result}. Raise a new inspection rather than overwriting a past verdict.`
      );
    }

    return sequelize.transaction(async (transaction) => {
      const lot = inspection.lotId
        ? await StockLot.findOne({ where: { id: inspection.lotId }, transaction, lock: transaction.LOCK.UPDATE })
        : null;

      await inspection.update(
        {
          result,
          testedValue: testedValue ?? inspection.testedValue,
          requiredValue: requiredValue ?? inspection.requiredValue,
          unitLabel: unitLabel ?? inspection.unitLabel,
          quantityRejected: quantityRejected ?? inspection.quantityRejected,
          remarks: remarks ?? inspection.remarks,
          recordedOn: new Date(),
          inspectedBy: getUserId() || null,
        },
        { transaction }
      );

      await this._applyVerdict(inspection, lot, transaction);
      return this.getInspection(id);
    });
  }

  /**
   * The only place a QC verdict changes stock state.
   *
   * Only a FINAL inspection releases or fails a lot: an IN_PROCESS check is
   * information about the run, not a decision about sellability, and an
   * INCOMING one is about supplier material that the goods receipt has already
   * split into accepted and rejected quantities.
   */
  static async _applyVerdict(inspection, lot, transaction) {
    if (inspection.inspectionType !== 'FINAL' || !lot) return;

    if (inspection.result === 'PASS') {
      // Release only from QC_HOLD. A lot still CURING is not yet old enough to
      // sell whatever the test says, and promoteEligibleLots will route it to
      // QC_HOLD (not AVAILABLE) when its curing period ends — where this
      // passing result is waiting for it.
      if (lot.status === 'QC_HOLD') {
        await lot.update({ status: 'AVAILABLE' }, { transaction });
      }
      return;
    }

    // FAIL: quarantine whatever is left. The stock is not destroyed — the
    // quantity stays on the lot and in the ledger — it simply stops being
    // sellable, because writing it off is a separate decision (a wastage
    // record) that someone has to take deliberately.
    if (['QC_HOLD', 'CURING', 'AVAILABLE'].includes(lot.status)) {
      await lot.update({ status: 'QC_FAILED' }, { transaction });
    }
  }

  /**
   * Lots sitting in QC_HOLD with no passing FINAL inspection — the work list
   * for a lab, and the answer to "why can I not dispatch this?".
   */
  static async listHeldLots(page, limit, { factoryId, productId, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere, status: { [Op.in]: ['QC_HOLD', 'QC_FAILED'] } };
    if (factoryId) where.factoryId = factoryId;
    if (productId) where.productId = productId;

    return StockLot.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: Product, as: 'product' },
        { model: QualityInspection, as: 'inspections' },
      ],
      order: [['originDate', 'ASC']],
    });
  }
}

module.exports = { QualityService };
