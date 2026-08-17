const crypto = require('crypto');
const { searchWhere } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');
const { ContractorMaterialIssue } = require('./contractorMaterialIssue.model');
const { ContractorMaterialIssueLine } = require('./contractorMaterialIssueLine.model');
const { ContractorProductionEntry } = require('./contractorProductionEntry.model');
const { AttendanceRecord } = require('./attendanceRecord.model');
const { Advance } = require('./advance.model');
const { Party } = require('../parties/party.model');
const { LabourWageProfile } = require('../parties/labourWageProfile.model');
const { Product } = require('../products/product.model');
const { MixDesign } = require('../products/mixDesign.model');
const { MixDesignLine } = require('../products/mixDesignLine.model');
const { BomService } = require('../products/bom.service');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { PricingService } = require('../pricing/pricing.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const STANDARD_WORK_HOURS = 8;

class WorkforceService {
  // --- BR-23: Contractor material issue ("With Contractor" location) ---
  static async listMaterialIssues(page, limit, { factoryId, contractorPartyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (contractorPartyId) where.contractorPartyId = contractorPartyId;
    if (search) Object.assign(where, searchWhere(search, ['issueNumber']));
    return ContractorMaterialIssue.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'contractor' }, { model: ContractorMaterialIssueLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['issueDate', 'DESC']],
    });
  }

  static async getMaterialIssue(id) {
    const record = await ContractorMaterialIssue.findByPk(id, {
      include: [{ model: Party, as: 'contractor' }, { model: ContractorMaterialIssueLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
    });
    if (!record) throw new NotFoundError('Contractor material issue not found');
    return record;
  }

  static async issueMaterialToContractor({ factoryId, contractorPartyId, issueDate, lines }) {
    if (!lines || !lines.length) throw new ValidationError('A material issue requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('CONTRACTOR_ISSUE', { factoryId, financialYearId, prefix: 'CMI', transaction });

      const issue = await ContractorMaterialIssue.create({ factoryId, issueNumber: documentNumber, contractorPartyId, issueDate }, { transaction });

      for (const line of lines) {
        // Leaves normal factory stock...
        await StockLedgerService.consumeFifo({
          factoryId, productId: line.productId, quantity: line.quantity, movementType: 'CONTRACTOR_ISSUE_OUT',
          referenceType: 'ContractorMaterialIssue', referenceId: issue.id,
          overrideLotId: line.lotId, overrideReason: line.lotId ? 'Contractor issue' : undefined,
          transaction,
        });

        // ...and lands in a WITH_CONTRACTOR lot — still BPL stock (BR-23), just held elsewhere.
        const newLot = await StockLedgerService.createLot({
          factoryId, productId: line.productId, lotNumber: `${documentNumber}-${line.productId.slice(0, 8)}`,
          originType: 'CONTRACTOR_ISSUE', originId: issue.id, originDate: issueDate,
          statusOverride: 'WITH_CONTRACTOR', heldByPartyId: contractorPartyId, quantity: line.quantity, transaction,
        });
        await StockLedgerService.postEntry({
          factoryId, productId: line.productId, lotId: newLot.id, movementType: 'CONTRACTOR_ISSUE_IN', direction: 'IN',
          quantity: line.quantity, referenceType: 'ContractorMaterialIssue', referenceId: issue.id, transaction,
        });

        await ContractorMaterialIssueLine.create(
          { contractorMaterialIssueId: issue.id, productId: line.productId, quantity: line.quantity, createdLotId: newLot.id },
          { transaction }
        );
      }

      return this.getMaterialIssue(issue.id);
    });
  }

  // --- BR-22: Contractor production entry (piece-rate, atomic three-in-one) ---
  static async listContractorEntries(page, limit, { factoryId, contractorPartyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (contractorPartyId) where.contractorPartyId = contractorPartyId;
    if (search) Object.assign(where, searchWhere(search, ['entryNumber']));
    return ContractorProductionEntry.findAndCountAll({
      where, limit, offset, include: [{ model: Party, as: 'contractor' }, { model: Product, as: 'product' }], order: [['productionDate', 'DESC']],
    });
  }

  static async getContractorEntry(id) {
    const record = await ContractorProductionEntry.findByPk(id, { include: [{ model: Party, as: 'contractor' }, { model: Product, as: 'product' }] });
    if (!record) throw new NotFoundError('Contractor production entry not found');
    return record;
  }

  static async createContractorProductionEntry({ factoryId, contractorPartyId, productId, productionDate, quantity, pieceRatePaiseOverride }) {
    if (Number(quantity) <= 0) throw new ValidationError('quantity must be positive');

    return sequelize.transaction(async (transaction) => {
      const product = await Product.findByPk(productId, { transaction });
      if (!product) throw new NotFoundError('Product not found');

      // FR-M03-8: the recipe in force on the production date (AC-2.1).
      const mixDesign = await BomService.resolveForDate(productId, productionDate, transaction);

      const resolvedRate = pieceRatePaiseOverride ?? (await PricingService.resolveRate(productId, { partyId: contractorPartyId, priceType: 'CONTRACTOR_RATE' }));
      if (!resolvedRate) throw new ValidationError('No contractor piece rate is configured for this product — add one under Price Lists (Contractor Rate)');

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('CONTRACTOR_PRODUCTION_ENTRY', { factoryId, financialYearId, prefix: 'CPE', transaction });

      const entryId = crypto.randomUUID();

      // 1) Creates finished stock (BR-22) — normal factory stock, same as an
      //    own-production entry; curing rules apply identically.
      const lot = await StockLedgerService.createLot({
        factoryId, productId, lotNumber: documentNumber, originType: 'PRODUCTION', originId: entryId,
        originDate: productionDate, curingDaysOverride: product.curingDays, quantity, transaction,
      });
      await StockLedgerService.postEntry({
        factoryId, productId, lotId: lot.id, movementType: 'PRODUCTION_IN', direction: 'IN', quantity,
        referenceType: 'ContractorProductionEntry', referenceId: entryId, transaction,
      });

      // 2) Consumes material out of the contractor's WITH_CONTRACTOR holding.
      for (const bomLine of mixDesign.lines) {
        const requiredQty = Number(bomLine.quantityPerUnit) * Number(quantity);
        await StockLedgerService.consumeFifo({
          factoryId, productId: bomLine.rawMaterialProductId, quantity: requiredQty, movementType: 'PRODUCTION_OUT',
          referenceType: 'ContractorProductionEntry', referenceId: entryId,
          sourceStatus: 'WITH_CONTRACTOR', heldByPartyId: contractorPartyId, transaction,
        });
      }

      const totalValuePaise = Math.round(Number(quantity) * resolvedRate);

      const entry = await ContractorProductionEntry.create(
        {
          id: entryId, factoryId, entryNumber: documentNumber, contractorPartyId, productId, mixDesignId: mixDesign.id,
          productionDate, quantity, pieceRatePaise: resolvedRate, totalValuePaise, curingDays: product.curingDays, lotId: lot.id,
        },
        { transaction }
      );

      // 3) Credits the contractor ledger.
      await LedgerService.postJournal({
        factoryId, entryDate: productionDate, referenceType: 'ContractorProductionEntry', referenceId: entryId,
        narration: `Contractor production ${documentNumber}`,
        lines: [
          { accountKey: 'JOB_WORK_EXPENSE', debitPaise: totalValuePaise, creditPaise: 0 },
          { accountKey: 'ACCOUNTS_PAYABLE', partyId: contractorPartyId, debitPaise: 0, creditPaise: totalValuePaise },
        ],
        transaction,
      });

      return this.getContractorEntry(entry.id);
    });
  }

  // --- BR-24: Labour attendance & wage accrual ---
  static async listAttendance(page, limit, { factoryId, labourPartyId } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (labourPartyId) where.labourPartyId = labourPartyId;
    return AttendanceRecord.findAndCountAll({ where, limit, offset, include: [{ model: Party, as: 'labour' }], order: [['attendanceDate', 'DESC']] });
  }

  static async markAttendance({ factoryId, labourPartyId, attendanceDate, status, overtimeHours }) {
    return sequelize.transaction(async (transaction) => {
      const existing = await AttendanceRecord.findOne({ where: { labourPartyId, attendanceDate }, transaction });
      if (existing) throw new ConflictError('Attendance for this labourer on this date is already recorded');

      const wageProfile = await LabourWageProfile.findOne({ where: { partyId: labourPartyId }, transaction });
      if (!wageProfile) throw new ValidationError('No wage profile is configured for this labourer — set one under Parties');

      const dailyWage = Number(wageProfile.dailyWagePaise);
      let wageAccruedPaise = 0;
      if (status === 'PRESENT') wageAccruedPaise = dailyWage;
      else if (status === 'HALF_DAY') wageAccruedPaise = Math.round(dailyWage * 0.5);
      else if (status === 'OVERTIME') {
        const hourlyRate = dailyWage / STANDARD_WORK_HOURS;
        wageAccruedPaise = dailyWage + Math.round(hourlyRate * Number(overtimeHours || 0) * Number(wageProfile.overtimeRateMultiplier));
      }
      // ABSENT stays 0.

      const record = await AttendanceRecord.create(
        { factoryId, labourPartyId, attendanceDate, status, overtimeHours: overtimeHours || null, wageAccruedPaise },
        { transaction }
      );

      if (wageAccruedPaise > 0) {
        await LedgerService.postJournal({
          factoryId, entryDate: attendanceDate, referenceType: 'AttendanceRecord', referenceId: record.id,
          narration: `Wage accrual — ${status} — ${attendanceDate}`,
          lines: [
            { accountKey: 'LABOUR_WAGE_EXPENSE', debitPaise: wageAccruedPaise, creditPaise: 0 },
            { accountKey: 'ACCOUNTS_PAYABLE', partyId: labourPartyId, debitPaise: 0, creditPaise: wageAccruedPaise },
          ],
          transaction,
        });
      }

      return record;
    });
  }

  // --- BR-25: Advances (contractor & labour) ---
  static async listAdvances(page, limit, { factoryId, partyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (partyId) where.partyId = partyId;
    if (search) Object.assign(where, searchWhere(search, ['advanceNumber', 'reason']));
    return Advance.findAndCountAll({ where, limit, offset, include: [{ model: Party, as: 'party' }], order: [['advanceDate', 'DESC']] });
  }

  static async getAdvance(id) {
    const record = await Advance.findByPk(id, { include: [{ model: Party, as: 'party' }] });
    if (!record) throw new NotFoundError('Advance not found');
    return record;
  }

  static async createAdvance({ factoryId, partyId, advanceDate, mode, amountPaise, reason }) {
    if (!amountPaise || amountPaise <= 0) throw new ValidationError('amountPaise must be positive');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('ADVANCE', { factoryId, financialYearId, prefix: 'ADV', transaction });

      const advance = await Advance.create({ factoryId, advanceNumber: documentNumber, partyId, advanceDate, mode, amountPaise, reason }, { transaction });

      await LedgerService.postJournal({
        factoryId, entryDate: advanceDate, referenceType: 'Advance', referenceId: advance.id,
        narration: `Advance ${documentNumber}${reason ? `: ${reason}` : ''}`,
        lines: [
          { accountKey: 'ACCOUNTS_PAYABLE', partyId, debitPaise: amountPaise, creditPaise: 0 },
          { accountKey: mode === 'CASH' ? 'CASH' : 'BANK', debitPaise: 0, creditPaise: amountPaise },
        ],
        transaction,
      });

      return this.getAdvance(advance.id);
    });
  }

  static async cancelAdvance(id, reason) {
    const advance = await this.getAdvance(id);
    if (advance.status !== 'POSTED') throw new ValidationError(`Only a POSTED advance can be cancelled (current status: ${advance.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entry = await JournalEntry.findOne({ where: { referenceType: 'Advance', referenceId: advance.id }, transaction });
      if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);
      await advance.update({ status: 'CANCELLED' }, { transaction });
      return this.getAdvance(id);
    });
  }
}

module.exports = { WorkforceService };
