const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { FixedAsset, DepreciationRun } = require('./fixedAsset.model');
const { Party } = require('../parties/party.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { LedgerService } = require('../ledger/ledger.service');
const { AccountsService } = require('../ledger/accounts.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { assertNotFuture } = require('../../utils/businessDate');

/**
 * Fixed assets: register, depreciate, dispose.
 *
 * ## Depreciation
 *
 * Charged by the day, from the later of the put-to-use date and the day after
 * the last charge, up to the run's date:
 *
 *   SLM  (cost − salvage) ÷ useful life, per year
 *   WDV  (cost − accumulated depreciation) × rate, per year
 *
 * Both are capped so book value never falls below salvage value. WDV is
 * applied to the book value at the time of each run, so monthly runs compound
 * slightly more than one annual run at the same rate would; run it yearly if
 * you want the textbook annual figure.
 *
 * ## Why only the latest run can be cancelled
 *
 * Each run starts where the previous one stopped (`depreciatedUpTo`), and a WDV
 * charge depends on the depreciation before it. Cancelling a run from the
 * middle would leave the later ones charged on a book value that no longer
 * exists. Undo backwards, one run at a time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const toDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(toDate(isoDate).getTime() + n * DAY_MS));
const daysInclusive = (from, to) => Math.round((toDate(to) - toDate(from)) / DAY_MS) + 1;

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

/** Plain view with BIGINTs as numbers and book value worked out. */
const assetView = (asset) => {
  const json = asset.toJSON();
  const cost = Number(json.costPaise);
  const accumulated = Number(json.accumulatedDepreciationPaise);
  return {
    ...json,
    costPaise: cost,
    salvageValuePaise: Number(json.salvageValuePaise),
    accumulatedDepreciationPaise: accumulated,
    disposalProceedsPaise: json.disposalProceedsPaise === null ? null : Number(json.disposalProceedsPaise),
    ratePercent: json.ratePercent === null ? null : Number(json.ratePercent),
    bookValuePaise: cost - accumulated,
  };
};

class FixedAssetsService {
  /**
   * What depreciating `asset` up to `upTo` would charge, and from when.
   * Pure — used by the preview, the run and the disposal alike, so all three
   * agree on the figure.
   */
  static chargeFor(asset, upTo) {
    const cost = Number(asset.costPaise);
    const salvage = Number(asset.salvageValuePaise || 0);
    const accumulated = Number(asset.accumulatedDepreciationPaise || 0);
    const headroom = cost - salvage - accumulated;
    if (headroom <= 0) return null;

    const from = asset.depreciatedUpTo
      ? addDays(asset.depreciatedUpTo, 1)
      : String(asset.putToUseDate).slice(0, 10);
    const start = from > String(asset.putToUseDate).slice(0, 10) ? from : String(asset.putToUseDate).slice(0, 10);
    if (start > upTo) return null;

    const days = daysInclusive(start, upTo);
    let annual;
    if (asset.method === 'SLM') {
      annual = (cost - salvage) / (Number(asset.usefulLifeMonths) / 12);
    } else {
      annual = (cost - accumulated) * (Number(asset.ratePercent) / 100);
    }
    const amount = Math.min(Math.round((annual * days) / 365), headroom);
    if (amount <= 0) return null;
    return { fromDate: start, days, amountPaise: amount };
  }

  static validateMethod({ method, usefulLifeMonths, ratePercent, costPaise, salvageValuePaise = 0 }) {
    if (method === 'SLM' && !(Number(usefulLifeMonths) > 0)) throw new ValidationError('Straight-line depreciation needs a useful life in months');
    if (method === 'WDV' && !(Number(ratePercent) > 0 && Number(ratePercent) <= 100)) {
      throw new ValidationError('Written-down-value depreciation needs a yearly rate between 0 and 100%');
    }
    if (!(Number(costPaise) > 0)) throw new ValidationError('The cost must be more than zero');
    if (Number(salvageValuePaise) < 0 || Number(salvageValuePaise) >= Number(costPaise)) {
      throw new ValidationError('The salvage value must be less than the cost');
    }
  }

  static async list(page, limit, { status, category, search, baseWhere = {} } = {}) {
    const where = { ...baseWhere };
    if (status) where.status = status;
    if (category) where.category = category;
    if (search) Object.assign(where, searchWhere(search, ['assetNumber', 'name', 'category', 'serialNumber']));
    const { rows, count } = await FixedAsset.findAndCountAll({
      where, limit, offset: (page - 1) * limit,
      include: [{ model: Party, as: 'vendor', attributes: ['id', 'name'] }],
      order: [['acquisitionDate', 'DESC'], ['assetNumber', 'DESC']],
    });
    return { rows: rows.map(assetView), count };
  }

  static async get(id, transaction) {
    const asset = await FixedAsset.findByPk(id, { include: [{ model: Party, as: 'vendor', attributes: ['id', 'name'] }], transaction });
    if (!asset) throw new NotFoundError('Asset not found');
    return asset;
  }

  static async getView(id) {
    return assetView(await this.get(id));
  }

  /**
   * Registers an asset and posts its cost.
   *
   * PURCHASED: Dr Fixed Assets, Cr the cash/bank account it was paid from.
   * EXISTING (owned before go-live): Dr Fixed Assets at cost, Cr Accumulated
   * Depreciation with what has already been charged, Cr Opening Balance Equity
   * with the difference — the same contra every go-live figure uses.
   */
  static async create(input) {
    const {
      factoryId, name, category, serialNumber, description, acquisitionType, acquisitionDate, putToUseDate,
      costPaise, salvageValuePaise = 0, method, usefulLifeMonths, ratePercent, vendorPartyId,
      payment, openingAccumulatedPaise = 0,
    } = input;

    this.validateMethod({ method, usefulLifeMonths, ratePercent, costPaise, salvageValuePaise });
    assertNotFuture(acquisitionDate, 'The date an asset was acquired');
    const useFrom = putToUseDate || acquisitionDate;
    if (useFrom < acquisitionDate) throw new ValidationError('An asset cannot be put to use before it was acquired');
    const priorDep = Number(openingAccumulatedPaise || 0);
    if (acquisitionType === 'EXISTING' && (priorDep < 0 || priorDep > Number(costPaise) - Number(salvageValuePaise))) {
      throw new ValidationError('Depreciation already charged cannot exceed cost less salvage value');
    }

    return sequelize.transaction(async (transaction) => {
      let paidFrom = null;
      if (acquisitionType === 'PURCHASED') {
        if (!payment?.mode) throw new ValidationError('Say how the asset was paid for (cash or bank)');
        paidFrom = await AccountsService.resolveMoneyAccount({ accountId: payment.accountId, mode: payment.mode }, transaction);
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('FIXED_ASSET', { factoryId, financialYearId, prefix: 'FA', transaction });

      const asset = await FixedAsset.create(
        {
          factoryId, assetNumber: documentNumber, name: name.trim(), category: category.trim(),
          serialNumber: serialNumber || null, description: description || null,
          acquisitionType, acquisitionDate, putToUseDate: useFrom,
          paidFromAccountId: paidFrom?.accountId || null, vendorPartyId: vendorPartyId || null,
          costPaise, salvageValuePaise, method,
          usefulLifeMonths: method === 'SLM' ? usefulLifeMonths : null,
          ratePercent: method === 'WDV' ? ratePercent : null,
          accumulatedDepreciationPaise: acquisitionType === 'EXISTING' ? priorDep : 0,
          // An existing asset has been depreciated up to the day before it
          // came onto these books; the first run continues from there.
          depreciatedUpTo: acquisitionType === 'EXISTING' ? addDays(acquisitionDate, -1) : null,
        },
        { transaction }
      );

      const cost = Number(costPaise);
      const lines = [{ accountKey: 'FIXED_ASSETS', debitPaise: cost, creditPaise: 0 }];
      if (acquisitionType === 'PURCHASED') {
        lines.push(paidFrom.accountId
          ? { accountId: paidFrom.accountId, debitPaise: 0, creditPaise: cost }
          : { accountKey: paidFrom.accountKey, debitPaise: 0, creditPaise: cost });
      } else {
        if (priorDep > 0) lines.push({ accountKey: 'ACCUMULATED_DEPRECIATION', debitPaise: 0, creditPaise: priorDep });
        lines.push({ accountKey: 'OPENING_BALANCE_EQUITY', debitPaise: 0, creditPaise: cost - priorDep });
      }

      await LedgerService.postJournal({
        factoryId, entryDate: acquisitionDate, referenceType: 'FixedAsset', referenceId: asset.id,
        narration: `${acquisitionType === 'EXISTING' ? 'Existing asset brought in' : 'Asset purchased'}: ${documentNumber} ${name.trim()}`.slice(0, 255),
        lines, transaction,
      });

      return assetView(await this.get(asset.id, transaction));
    });
  }

  /** Descriptive fields only. Figures that have been posted are changed by disposal, not by editing. */
  static async update(id, { name, category, serialNumber, description }) {
    const asset = await this.get(id);
    const changes = {};
    if (name !== undefined) changes.name = String(name).trim();
    if (category !== undefined) changes.category = String(category).trim();
    if (serialNumber !== undefined) changes.serialNumber = serialNumber || null;
    if (description !== undefined) changes.description = description || null;
    await asset.update(changes);
    return this.getView(id);
  }

  /** What a run up to `upTo` would charge, asset by asset. Posts nothing. */
  static async previewDepreciation({ factoryId, upTo }) {
    const assets = await FixedAsset.findAll({ where: { factoryId, status: 'ACTIVE' }, order: [['assetNumber', 'ASC']] });
    const lines = [];
    for (const asset of assets) {
      const charge = this.chargeFor(asset, upTo);
      if (!charge) continue;
      lines.push({
        assetId: asset.id, assetNumber: asset.assetNumber, name: asset.name, method: asset.method,
        fromDate: charge.fromDate, days: charge.days, amountPaise: charge.amountPaise,
        bookValueBeforePaise: Number(asset.costPaise) - Number(asset.accumulatedDepreciationPaise),
      });
    }
    return { factoryId, upTo, lines, totalPaise: lines.reduce((s, l) => s + l.amountPaise, 0) };
  }

  static async runDepreciation({ factoryId, upTo }) {
    // Depreciation is wear that has already happened.
    assertNotFuture(upTo, 'A depreciation run date');
    return sequelize.transaction(async (transaction) => {
      // Locked so two people running the same month cannot both charge it.
      const assets = await FixedAsset.findAll({
        where: { factoryId, status: 'ACTIVE' }, order: [['assetNumber', 'ASC']], transaction, lock: transaction.LOCK.UPDATE,
      });

      const lines = [];
      for (const asset of assets) {
        const charge = this.chargeFor(asset, upTo);
        if (!charge) continue;
        lines.push({ assetId: asset.id, amountPaise: charge.amountPaise, fromDate: charge.fromDate, previousUpTo: asset.depreciatedUpTo || null });
        await asset.update(
          { accumulatedDepreciationPaise: Number(asset.accumulatedDepreciationPaise) + charge.amountPaise, depreciatedUpTo: upTo },
          { transaction }
        );
      }
      if (!lines.length) throw new ValidationError(`Nothing to depreciate at this factory up to ${upTo} — every asset is already charged to that date or fully depreciated`);

      const totalPaise = lines.reduce((s, l) => s + l.amountPaise, 0);
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('DEPRECIATION_RUN', { factoryId, financialYearId, prefix: 'DEP', transaction });

      const run = await DepreciationRun.create({ factoryId, runNumber: documentNumber, upToDate: upTo, totalPaise, lines, status: 'POSTED' }, { transaction });

      await LedgerService.postJournal({
        factoryId, entryDate: upTo, referenceType: 'DepreciationRun', referenceId: run.id,
        narration: `Depreciation ${documentNumber} up to ${upTo} (${lines.length} asset${lines.length === 1 ? '' : 's'})`,
        lines: [
          { accountKey: 'DEPRECIATION_EXPENSE', debitPaise: totalPaise, creditPaise: 0 },
          { accountKey: 'ACCUMULATED_DEPRECIATION', debitPaise: 0, creditPaise: totalPaise },
        ],
        transaction,
      });

      return { ...run.toJSON(), totalPaise };
    });
  }

  /** A single run, so the controller can check location access before cancelling it. */
  static async getRun(id) {
    const run = await DepreciationRun.findByPk(id);
    if (!run) throw new NotFoundError('Depreciation run not found');
    return { ...run.toJSON(), totalPaise: Number(run.totalPaise) };
  }

  static async listRuns(page, limit, { baseWhere = {} } = {}) {
    const { rows, count } = await DepreciationRun.findAndCountAll({
      where: baseWhere, limit, offset: (page - 1) * limit, order: [['upToDate', 'DESC'], ['createdAt', 'DESC']],
    });
    return { rows: rows.map((r) => ({ ...r.toJSON(), totalPaise: Number(r.totalPaise) })), count };
  }

  static async cancelRun(id, reason) {
    if (!reason || !String(reason).trim()) throw new ValidationError('A cancellation reason is required');
    return sequelize.transaction(async (transaction) => {
      const run = await DepreciationRun.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!run) throw new NotFoundError('Depreciation run not found');
      if (run.status !== 'POSTED') throw new ValidationError('This run is already cancelled');

      const later = await DepreciationRun.findOne({
        where: {
          factoryId: run.factoryId, status: 'POSTED', id: { [Op.ne]: run.id },
          [Op.or]: [{ upToDate: { [Op.gt]: run.upToDate } }, { upToDate: run.upToDate, createdAt: { [Op.gt]: run.createdAt } }],
        },
        transaction,
      });
      if (later) throw new ValidationError(`Cancel ${later.runNumber} first — runs are undone latest first`);

      for (const line of run.lines) {
        const asset = await FixedAsset.findByPk(line.assetId, { transaction, lock: transaction.LOCK.UPDATE });
        if (asset.status === 'DISPOSED') {
          throw new ValidationError(`${asset.assetNumber} has been disposed of since this run — it can no longer be undone`);
        }
        await asset.update(
          { accumulatedDepreciationPaise: Number(asset.accumulatedDepreciationPaise) - Number(line.amountPaise), depreciatedUpTo: line.previousUpTo },
          { transaction }
        );
      }

      const entry = await JournalEntry.findOne({ where: { referenceType: 'DepreciationRun', referenceId: run.id, reversalOfEntryId: null }, transaction });
      // Dated on the run's own date: a cancelled run should not show on a
      // balance sheet for any day, including the days between the two.
      if (entry) await LedgerService.reverseJournal(entry.id, `Depreciation ${run.runNumber} cancelled: ${String(reason).trim()}`, transaction, run.upToDate);
      await run.update({ status: 'CANCELLED', cancelReason: String(reason).trim() }, { transaction });
      return { ...run.toJSON(), totalPaise: Number(run.totalPaise) };
    });
  }

  /**
   * Sells or scraps an asset.
   *
   * Depreciation is first charged up to the disposal date, so the gain or loss
   * is measured against the book value on the day it left — not against
   * whenever the last run happened to be. Then: Dr cash/bank with the
   * proceeds, Dr Accumulated Depreciation with everything charged, Cr Fixed
   * Assets with the cost, and the remainder to Profit/Loss on Sale of Assets.
   */
  static async dispose(id, { disposedOn, proceedsPaise = 0, payment, note }) {
    return sequelize.transaction(async (transaction) => {
      const asset = await FixedAsset.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!asset) throw new NotFoundError('Asset not found');
      if (asset.status !== 'ACTIVE') throw new ValidationError(`${asset.assetNumber} has already been disposed of`);
      assertNotFuture(disposedOn, 'A disposal date');
      if (disposedOn < String(asset.acquisitionDate).slice(0, 10)) throw new ValidationError('An asset cannot be disposed of before it was acquired');
      if (asset.depreciatedUpTo && disposedOn < String(asset.depreciatedUpTo).slice(0, 10)) {
        throw new ValidationError(`${asset.assetNumber} is depreciated up to ${asset.depreciatedUpTo}; cancel the later depreciation run or dispose on or after that date`);
      }

      const proceeds = Number(proceedsPaise || 0);
      let receivedInto = null;
      if (proceeds > 0) {
        if (!payment?.mode) throw new ValidationError('Say where the sale money went (cash or bank)');
        receivedInto = await AccountsService.resolveMoneyAccount({ accountId: payment.accountId, mode: payment.mode }, transaction);
      }

      const finalCharge = this.chargeFor(asset, disposedOn);
      const accumulated = Number(asset.accumulatedDepreciationPaise) + (finalCharge?.amountPaise || 0);
      const cost = Number(asset.costPaise);
      const gain = proceeds - (cost - accumulated);

      const lines = [];
      if (finalCharge) {
        lines.push({ accountKey: 'DEPRECIATION_EXPENSE', debitPaise: finalCharge.amountPaise, creditPaise: 0 });
        lines.push({ accountKey: 'ACCUMULATED_DEPRECIATION', debitPaise: 0, creditPaise: finalCharge.amountPaise });
      }
      if (proceeds > 0) {
        lines.push(receivedInto.accountId
          ? { accountId: receivedInto.accountId, debitPaise: proceeds, creditPaise: 0 }
          : { accountKey: receivedInto.accountKey, debitPaise: proceeds, creditPaise: 0 });
      }
      if (accumulated > 0) lines.push({ accountKey: 'ACCUMULATED_DEPRECIATION', debitPaise: accumulated, creditPaise: 0 });
      lines.push({ accountKey: 'FIXED_ASSETS', debitPaise: 0, creditPaise: cost });
      if (gain > 0) lines.push({ accountKey: 'ASSET_DISPOSAL_GAIN_LOSS', debitPaise: 0, creditPaise: gain });
      if (gain < 0) lines.push({ accountKey: 'ASSET_DISPOSAL_GAIN_LOSS', debitPaise: -gain, creditPaise: 0 });

      await asset.update(
        {
          status: 'DISPOSED', disposedOn, disposalProceedsPaise: proceeds, disposalNote: note || null,
          accumulatedDepreciationPaise: accumulated,
          depreciatedUpTo: finalCharge ? disposedOn : asset.depreciatedUpTo,
        },
        { transaction }
      );

      await LedgerService.postJournal({
        factoryId: asset.factoryId, entryDate: disposedOn, referenceType: 'FixedAssetDisposal', referenceId: asset.id,
        narration: `Asset disposed: ${asset.assetNumber} ${asset.name}`.slice(0, 255),
        lines, transaction,
      });

      return { ...assetView(await this.get(id, transaction)), gainPaise: gain };
    });
  }
}

module.exports = { FixedAssetsService };
