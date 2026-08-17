const { sequelize } = require('../../config/database');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { Uom } = require('../products/uom.model');
const { Factory } = require('../factory/factory.model');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { LedgerService } = require('../ledger/ledger.service');
const { ValidationError } = require('../../core/AppError');

/**
 * M29 — data migration and opening balances.
 *
 * AC-15 is a go/no-go criterion and turns on one thing: **opening stock lots
 * must carry their true original production date, not the import date**. If
 * they don't, every piece of yard stock looks brand new on day one and the
 * whole ageing/dead-stock module is worthless from the moment it goes live.
 *
 * Every import here is validate-everything-then-commit (FR-M29-2): the entire
 * file is checked first and a single bad row aborts the whole import, so there
 * is never a half-loaded master file to reconcile by hand.
 */

const REQUIRED = {
  products: ['code', 'name', 'uomCode', 'productType'],
  parties: ['partyType', 'name'],
  openingStock: ['factoryCode', 'productCode', 'quantity', 'productionDate'],
  openingPartyBalances: ['partyName', 'balancePaise'],
  openingCash: ['factoryCode', 'accountKey', 'balancePaise'],
};

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

class MigrationService {
  /** Shape/type checks that don't need the database. */
  static validateRows(kind, rows) {
    const required = REQUIRED[kind];
    if (!required) throw new ValidationError(`Unknown import type: ${kind}`);
    if (!Array.isArray(rows) || !rows.length) throw new ValidationError('The file contains no rows');

    const errors = [];
    rows.forEach((row, i) => {
      const rowNumber = i + 2; // +1 for zero-index, +1 for the header row
      for (const field of required) {
        if (isBlank(row[field])) errors.push({ row: rowNumber, field, message: `${field} is required` });
      }

      if (kind === 'openingStock') {
        if (!isBlank(row.quantity) && !(Number(row.quantity) > 0)) {
          errors.push({ row: rowNumber, field: 'quantity', message: 'quantity must be greater than zero' });
        }
        if (!isBlank(row.productionDate) && Number.isNaN(Date.parse(row.productionDate))) {
          errors.push({ row: rowNumber, field: 'productionDate', message: 'productionDate is not a valid date' });
        }
        // The whole point of AC-15: a future date means someone defaulted the
        // column to "today" instead of supplying the real production date.
        if (!isBlank(row.productionDate) && new Date(row.productionDate) > new Date()) {
          errors.push({
            row: rowNumber, field: 'productionDate',
            message: 'productionDate is in the future — opening stock must carry its ORIGINAL production date, not the import date',
          });
        }
      }

      if ((kind === 'openingPartyBalances' || kind === 'openingCash') && !isBlank(row.balancePaise)) {
        if (!Number.isInteger(Number(row.balancePaise))) {
          errors.push({ row: rowNumber, field: 'balancePaise', message: 'balancePaise must be a whole number of paise (BR-17)' });
        }
      }
    });

    return errors;
  }

  /** Cross-checks every row against existing master data before anything is written. */
  static async validate(kind, rows) {
    const errors = this.validateRows(kind, rows);
    if (errors.length) return { valid: false, errors, rowCount: rows.length };

    const dbErrors = [];
    const rowNo = (i) => i + 2;

    if (kind === 'products') {
      const uoms = await Uom.findAll({ attributes: ['id', 'code'] });
      const uomByCode = new Map(uoms.map((u) => [String(u.code).toUpperCase(), u.id]));
      const existing = await Product.findAll({ attributes: ['code'] });
      const existingCodes = new Set(existing.map((p) => String(p.code).toUpperCase()));
      const seen = new Set();

      rows.forEach((row, i) => {
        const code = String(row.code).toUpperCase();
        if (!uomByCode.has(String(row.uomCode).toUpperCase())) {
          dbErrors.push({ row: rowNo(i), field: 'uomCode', message: `Unknown unit of measure "${row.uomCode}"` });
        }
        if (existingCodes.has(code)) dbErrors.push({ row: rowNo(i), field: 'code', message: `Product "${row.code}" already exists` });
        if (seen.has(code)) dbErrors.push({ row: rowNo(i), field: 'code', message: `Duplicate code "${row.code}" within the file` });
        seen.add(code);
      });
    }

    if (kind === 'openingStock') {
      const [products, factories] = await Promise.all([
        Product.findAll({ attributes: ['id', 'code'] }),
        Factory.findAll({ attributes: ['id', 'code'] }),
      ]);
      const productByCode = new Map(products.map((p) => [String(p.code).toUpperCase(), p]));
      const factoryByCode = new Map(factories.map((f) => [String(f.code).toUpperCase(), f]));

      rows.forEach((row, i) => {
        if (!productByCode.has(String(row.productCode).toUpperCase())) {
          dbErrors.push({ row: rowNo(i), field: 'productCode', message: `Unknown product "${row.productCode}"` });
        }
        if (!factoryByCode.has(String(row.factoryCode).toUpperCase())) {
          dbErrors.push({ row: rowNo(i), field: 'factoryCode', message: `Unknown factory "${row.factoryCode}"` });
        }
      });
    }

    if (kind === 'openingPartyBalances') {
      const parties = await Party.findAll({ attributes: ['id', 'name'] });
      const byName = new Map(parties.map((p) => [String(p.name).trim().toLowerCase(), p]));
      rows.forEach((row, i) => {
        if (!byName.has(String(row.partyName).trim().toLowerCase())) {
          dbErrors.push({ row: rowNo(i), field: 'partyName', message: `Unknown party "${row.partyName}"` });
        }
      });
    }

    if (kind === 'openingCash') {
      const factories = await Factory.findAll({ attributes: ['id', 'code'] });
      const byCode = new Map(factories.map((f) => [String(f.code).toUpperCase(), f]));
      rows.forEach((row, i) => {
        if (!byCode.has(String(row.factoryCode).toUpperCase())) {
          dbErrors.push({ row: rowNo(i), field: 'factoryCode', message: `Unknown factory "${row.factoryCode}"` });
        }
        if (!['CASH', 'BANK'].includes(String(row.accountKey).toUpperCase())) {
          dbErrors.push({ row: rowNo(i), field: 'accountKey', message: 'accountKey must be CASH or BANK' });
        }
      });
    }

    return { valid: dbErrors.length === 0, errors: dbErrors, rowCount: rows.length };
  }

  /**
   * FR-M29-2: imports the whole file or none of it. `dryRun` validates and
   * reports without writing, so an import can be rehearsed safely (FR-M29-4).
   */
  static async import(kind, rows, { dryRun = false } = {}) {
    const validation = await this.validate(kind, rows);
    if (!validation.valid) {
      return { imported: 0, ...validation, committed: false };
    }
    if (dryRun) return { imported: 0, ...validation, committed: false, dryRun: true };

    const result = await sequelize.transaction(async (transaction) => {
      switch (kind) {
        case 'products':
          return this.importProducts(rows, transaction);
        case 'parties':
          return this.importParties(rows, transaction);
        case 'openingStock':
          return this.importOpeningStock(rows, transaction);
        case 'openingPartyBalances':
          return this.importOpeningPartyBalances(rows, transaction);
        case 'openingCash':
          return this.importOpeningCash(rows, transaction);
        default:
          throw new ValidationError(`Unknown import type: ${kind}`);
      }
    });

    return { ...validation, ...result, committed: true };
  }

  static async importProducts(rows, transaction) {
    const uoms = await Uom.findAll({ attributes: ['id', 'code'], transaction });
    const uomByCode = new Map(uoms.map((u) => [String(u.code).toUpperCase(), u.id]));

    const created = await Product.bulkCreate(
      rows.map((row) => ({
        code: row.code,
        name: row.name,
        uomId: uomByCode.get(String(row.uomCode).toUpperCase()),
        productType: row.productType,
        curingDays: Number(row.curingDays || 0),
        standardCostPaise: Number(row.standardCostPaise || 0),
        reorderLevel: Number(row.reorderLevel || 0),
      })),
      { transaction, individualHooks: true, validate: true }
    );
    return { imported: created.length };
  }

  static async importParties(rows, transaction) {
    const created = await Party.bulkCreate(
      rows.map((row) => ({
        partyType: row.partyType,
        name: row.name,
        gstin: row.gstin || null,
        phone: row.phone || null,
        email: row.email || null,
        state: row.state || null,
        creditLimitPaise: Number(row.creditLimitPaise || 0),
        creditAgeingDays: Number(row.creditAgeingDays || 0),
      })),
      { transaction, individualHooks: true, validate: true }
    );
    return { imported: created.length };
  }

  /**
   * AC-15: every lot keeps the production date supplied in the file. That date
   * flows straight into the ageing engine, so a lot produced 200 days before
   * go-live is classified DEAD on day one — which is the entire point.
   */
  static async importOpeningStock(rows, transaction) {
    const [products, factories] = await Promise.all([
      Product.findAll({ attributes: ['id', 'code', 'curingDays'], transaction }),
      Factory.findAll({ attributes: ['id', 'code'], transaction }),
    ]);
    const productByCode = new Map(products.map((p) => [String(p.code).toUpperCase(), p]));
    const factoryByCode = new Map(factories.map((f) => [String(f.code).toUpperCase(), f]));

    let imported = 0;
    for (const [i, row] of rows.entries()) {
      const product = productByCode.get(String(row.productCode).toUpperCase());
      const factory = factoryByCode.get(String(row.factoryCode).toUpperCase());

      const lot = await StockLedgerService.createLot({
        factoryId: factory.id,
        productId: product.id,
        lotNumber: row.lotNumber || `OPENING/${factory.code}/${product.code}/${i + 1}`,
        originType: 'PURCHASE',
        originId: factory.id,
        // NOT new Date() — the supplied original production date.
        originDate: String(row.productionDate).slice(0, 10),
        curingDaysOverride: Number(row.curingDays ?? product.curingDays ?? 0),
        quantity: Number(row.quantity),
        transaction,
      });

      await StockLedgerService.postEntry({
        factoryId: factory.id,
        productId: product.id,
        lotId: lot.id,
        movementType: 'ADJUSTMENT_IN',
        direction: 'IN',
        quantity: Number(row.quantity),
        referenceType: 'OpeningBalance',
        referenceId: factory.id,
        notes: 'Opening stock import (M29)',
        transaction,
      });
      imported += 1;
    }
    return { imported };
  }

  /**
   * Opening party balances post through the journal like everything else
   * (AP-3), against an opening-balance equity account, so the trial balance
   * still balances after migration.
   */
  static async importOpeningPartyBalances(rows, transaction) {
    const parties = await Party.findAll({ attributes: ['id', 'name'], transaction });
    const byName = new Map(parties.map((p) => [String(p.name).trim().toLowerCase(), p]));

    const factory = await Factory.findOne({ transaction });
    if (!factory) throw new ValidationError('At least one factory must exist before importing opening balances');

    let imported = 0;
    for (const row of rows) {
      const party = byName.get(String(row.partyName).trim().toLowerCase());
      const balance = Number(row.balancePaise);
      if (balance === 0) continue;

      // Positive = they owe us (a receivable); negative = we owe them.
      const receivable = balance > 0;
      const amount = Math.abs(balance);

      await LedgerService.postJournal({
        factoryId: factory.id,
        entryDate: row.asOfDate || new Date().toISOString().slice(0, 10),
        referenceType: 'OpeningBalance',
        referenceId: party.id,
        narration: `Opening balance for ${party.name}`,
        lines: receivable
          ? [
              { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: party.id, debitPaise: amount, creditPaise: 0 },
              { accountKey: 'OPENING_BALANCE_EQUITY', debitPaise: 0, creditPaise: amount },
            ]
          : [
              { accountKey: 'OPENING_BALANCE_EQUITY', debitPaise: amount, creditPaise: 0 },
              { accountKey: 'ACCOUNTS_PAYABLE', partyId: party.id, debitPaise: 0, creditPaise: amount },
            ],
        transaction,
      });
      imported += 1;
    }
    return { imported };
  }

  static async importOpeningCash(rows, transaction) {
    const factories = await Factory.findAll({ attributes: ['id', 'code'], transaction });
    const byCode = new Map(factories.map((f) => [String(f.code).toUpperCase(), f]));

    let imported = 0;
    for (const row of rows) {
      const factory = byCode.get(String(row.factoryCode).toUpperCase());
      const balance = Number(row.balancePaise);
      if (balance === 0) continue;
      const accountKey = String(row.accountKey).toUpperCase();

      await LedgerService.postJournal({
        factoryId: factory.id,
        entryDate: row.asOfDate || new Date().toISOString().slice(0, 10),
        referenceType: 'OpeningBalance',
        referenceId: factory.id,
        narration: `Opening ${accountKey.toLowerCase()} balance at ${factory.code}`,
        lines: [
          { accountKey, debitPaise: balance, creditPaise: 0 },
          { accountKey: 'OPENING_BALANCE_EQUITY', debitPaise: 0, creditPaise: balance },
        ],
        transaction,
      });
      imported += 1;
    }
    return { imported };
  }

  /** FR-M29-5: imported totals vs the client's control totals. */
  static async reconcile(kind, controlTotals = {}) {
    if (kind === 'openingStock') {
      const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
      const rows = await StockLedgerEntry.findAll({
        where: { referenceType: 'OpeningBalance' },
        attributes: ['productId', 'quantity'],
      });
      const importedQty = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
      const expected = Number(controlTotals.totalQuantity ?? NaN);
      return {
        kind,
        importedQuantity: importedQty,
        controlQuantity: Number.isFinite(expected) ? expected : null,
        matches: Number.isFinite(expected) ? Math.abs(importedQty - expected) < 1e-6 : null,
      };
    }

    if (kind === 'openingPartyBalances') {
      const trial = await LedgerService.getTrialBalance();
      const ar = trial.find((a) => a.code === '1100')?.balancePaise || 0;
      const ap = trial.find((a) => a.code === '2000')?.balancePaise || 0;
      return {
        kind,
        receivablesPaise: ar,
        payablesPaise: -ap,
        controlReceivablesPaise: controlTotals.receivablesPaise ?? null,
        controlPayablesPaise: controlTotals.payablesPaise ?? null,
        matches:
          controlTotals.receivablesPaise === undefined
            ? null
            : ar === Number(controlTotals.receivablesPaise) && -ap === Number(controlTotals.payablesPaise ?? -ap),
      };
    }

    throw new ValidationError(`No reconciliation is defined for "${kind}"`);
  }

  /** FR-M29-1: the column list each template must contain. */
  static templates() {
    return Object.entries(REQUIRED).map(([kind, required]) => ({
      kind,
      requiredColumns: required,
      optionalColumns: {
        products: ['curingDays', 'standardCostPaise', 'reorderLevel'],
        parties: ['gstin', 'phone', 'email', 'state', 'creditLimitPaise', 'creditAgeingDays'],
        openingStock: ['lotNumber', 'curingDays'],
        openingPartyBalances: ['asOfDate'],
        openingCash: ['asOfDate'],
      }[kind],
    }));
  }
}

module.exports = { MigrationService };
