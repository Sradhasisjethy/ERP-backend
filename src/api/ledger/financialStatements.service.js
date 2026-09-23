const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { env } = require('../../config/env');
const { getTenantId } = require('../../core/tenantContext');
const { ValidationError } = require('../../core/AppError');
const { ACCOUNT_GROUPS } = require('./accountGroups');
const { groupOf } = require('./accounts.service');
const { FinancialYear } = require('../factory/financialYear.model');
const { isoDateInZone } = require('../../utils/dateDisplay');

/**
 * Profit & Loss and Balance Sheet, read straight from the journal.
 *
 * ## Why stock appears here although the ledger has no stock account
 *
 * Purchases post to Purchase Expense the moment goods arrive — the ledger
 * never holds inventory as an asset. A P&L built from the journal alone would
 * therefore charge every bag of cement bought this month against this month's
 * sales, and a plant that bought ahead would show a loss it did not make. The
 * trading account fixes that the way every Indian set of books does: opening
 * stock is added to cost, closing stock deducted.
 *
 * Stock is valued from the stock ledger at each product's **standard cost**,
 * the same basis every stock-value figure in the system already uses (see
 * reports/lib/fragments.js#lotValue). A product with stock but no standard
 * cost is valued at zero and counted in `unvaluedProducts`, so the gap is
 * visible rather than silent.
 *
 * ## Stock brought in at go-live
 *
 * Opening stock imported by the migration module (stock ledger entries with
 * referenceType 'OpeningBalance') was never purchased through the books, so
 * nothing in the ledger paid for it. It is treated as capital the business
 * started with: part of opening stock in the P&L, and shown separately in the
 * balance sheet's capital section — otherwise the first year's profit would
 * include the whole value of the stock the business already owned.
 *
 * ## Why the balance sheet balances by construction
 *
 * Every journal is balanced, so the sum of all ledger balances is zero. The
 * balance sheet adds stock on hand to assets and the same figure, split into
 * "brought in at go-live" and "earned since", to capital. Anything left over
 * would be a posting defect; `difference` reports it rather than hiding it.
 */

const dayBefore = (isoDate) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** SQL fragment + binds restricting journal entries to the caller's factories. */
const factoryClause = (column, binds, { factoryId, allowedFactoryIds }) => {
  if (factoryId) {
    binds.push(factoryId);
    return ` AND ${column} = $${binds.length}`;
  }
  if (Array.isArray(allowedFactoryIds)) {
    binds.push(allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000']);
    return ` AND ${column} = ANY($${binds.length}::uuid[])`;
  }
  return '';
};

class FinancialStatementsService {
  /** Debit and credit per account for entries dated within [from, to] (either end optional). */
  static async accountTotals({ from, to, scope }) {
    const binds = [getTenantId()];
    let where = 'jl."tenantId" = $1';
    if (from) { binds.push(from); where += ` AND je."entryDate" >= $${binds.length}`; }
    if (to) { binds.push(to); where += ` AND je."entryDate" <= $${binds.length}`; }
    where += factoryClause('je."factoryId"', binds, scope);

    const rows = await sequelize.query(
      `SELECT a.id, a.code, a.name, a.type, a."accountGroup", a."subType",
              COALESCE(SUM(jl."debitPaise"), 0)::bigint AS debit,
              COALESCE(SUM(jl."creditPaise"), 0)::bigint AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl."journalEntryId"
         JOIN accounts a ON a.id = jl."accountId"
        WHERE ${where}
        GROUP BY a.id
        ORDER BY a.code`,
      { bind: binds, type: QueryTypes.SELECT }
    );
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      group: groupOf(r),
      debitPaise: Number(r.debit),
      creditPaise: Number(r.credit),
    }));
  }

  /**
   * Stock on hand at the end of `asOf`, valued at standard cost.
   * `onlyOpeningImports` restricts it to stock brought in by the go-live import.
   */
  static async stockValue({ asOf, scope, onlyOpeningImports = false, after = null }) {
    const binds = [getTenantId(), env.APP_TIMEZONE, asOf];
    let where = `sle."tenantId" = $1 AND (sle."createdAt" AT TIME ZONE $2)::date <= $3`;
    if (after) { binds.push(after); where += ` AND (sle."createdAt" AT TIME ZONE $2)::date > $${binds.length}`; }
    if (onlyOpeningImports) where += ` AND sle."referenceType" = 'OpeningBalance'`;
    where += factoryClause('sle."factoryId"', binds, scope);

    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(ROUND(net.qty * COALESCE(p."standardCostPaise", 0))), 0)::bigint AS value,
              COUNT(*) FILTER (WHERE net.qty <> 0 AND COALESCE(p."standardCostPaise", 0) = 0)::int AS unvalued
         FROM (
           SELECT sle."productId",
                  SUM(CASE WHEN sle.direction = 'IN' THEN sle.quantity ELSE -sle.quantity END) AS qty
             FROM stock_ledger_entries sle
            WHERE ${where}
            GROUP BY sle."productId"
         ) net
         JOIN products p ON p.id = net."productId"`,
      { bind: binds, type: QueryTypes.SELECT }
    );
    return { valuePaise: Number(row.value), unvaluedProducts: Number(row.unvalued) };
  }

  /** The current financial year's start and today, when the caller gives no range. */
  static async defaultRange() {
    const today = isoDateInZone(new Date(), env.APP_TIMEZONE);
    const fy = await FinancialYear.findOne({ where: { isCurrent: true } });
    return { from: fy ? String(fy.startDate).slice(0, 10) : `${today.slice(0, 4)}-04-01`, to: today };
  }

  /**
   * Groups account rows into statement sections, signed so that the section's
   * natural balance is positive (income and liabilities read credit − debit;
   * assets and expenses debit − credit). Accounts with a zero figure are left
   * out; a contra account (Sales Return inside income) shows as a negative line.
   */
  static section(rows, groupKeys) {
    return groupKeys.map((key) => {
      const def = ACCOUNT_GROUPS[key];
      const creditNatural = ['INCOME', 'LIABILITY', 'EQUITY'].includes(def.type);
      const accounts = rows
        .filter((r) => r.group === key)
        .map((r) => ({
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          amountPaise: creditNatural ? r.creditPaise - r.debitPaise : r.debitPaise - r.creditPaise,
        }))
        .filter((a) => a.amountPaise !== 0);
      return { group: key, label: def.label, accounts, totalPaise: accounts.reduce((s, a) => s + a.amountPaise, 0) };
    });
  }

  static async profitAndLoss({ from, to, factoryId, allowedFactoryIds }) {
    const range = (!from || !to) ? await this.defaultRange() : null;
    const start = from || range.from;
    const end = to || range.to;
    if (start > end) throw new ValidationError('The start date must be on or before the end date');
    const scope = { factoryId, allowedFactoryIds };

    const [rows, openingStock, importedInPeriod, closingStock] = await Promise.all([
      this.accountTotals({ from: start, to: end, scope }),
      this.stockValue({ asOf: dayBefore(start), scope }),
      // Go-live stock that arrived inside the period was never bought through
      // the books, so it belongs with opening stock, not in this year's profit.
      this.stockValue({ asOf: end, after: dayBefore(start), scope, onlyOpeningImports: true }),
      this.stockValue({ asOf: end, scope }),
    ]);

    const [directIncome] = this.section(rows, ['DIRECT_INCOME']);
    const [directExpense] = this.section(rows, ['DIRECT_EXPENSE']);
    const [indirectIncome] = this.section(rows, ['INDIRECT_INCOME']);
    const [indirectExpense] = this.section(rows, ['INDIRECT_EXPENSE']);

    const openingStockPaise = openingStock.valuePaise + importedInPeriod.valuePaise;
    const closingStockPaise = closingStock.valuePaise;

    const grossProfitPaise = directIncome.totalPaise + closingStockPaise - openingStockPaise - directExpense.totalPaise;
    const netProfitPaise = grossProfitPaise + indirectIncome.totalPaise - indirectExpense.totalPaise;

    return {
      from: start,
      to: end,
      factoryId: factoryId || null,
      trading: {
        openingStockPaise,
        directExpense,
        directIncome,
        closingStockPaise,
        grossProfitPaise,
      },
      indirectIncome,
      indirectExpense,
      netProfitPaise,
      stockValuation: {
        basis: 'STANDARD_COST',
        unvaluedProducts: Math.max(openingStock.unvaluedProducts, closingStock.unvaluedProducts),
        // The stock ledger records when a movement was entered, not the date on
        // the document, so stock either side of a period boundary follows the
        // day it was keyed in.
        datedBy: 'RECORDED_AT',
      },
    };
  }

  static async balanceSheet({ asOf, factoryId, allowedFactoryIds }) {
    const date = asOf || (await this.defaultRange()).to;
    const scope = { factoryId, allowedFactoryIds };

    const [rows, stock, broughtIn] = await Promise.all([
      this.accountTotals({ to: date, scope }),
      this.stockValue({ asOf: date, scope }),
      this.stockValue({ asOf: date, scope, onlyOpeningImports: true }),
    ]);

    const assets = this.section(rows, ['FIXED_ASSET', 'INVESTMENT', 'CURRENT_ASSET', 'LOANS_ADVANCES']);
    const currentAssets = assets.find((s) => s.group === 'CURRENT_ASSET');
    if (stock.valuePaise !== 0) {
      currentAssets.accounts.unshift({ accountId: null, code: null, name: 'Closing Stock (at standard cost)', amountPaise: stock.valuePaise });
      currentAssets.totalPaise += stock.valuePaise;
    }

    const liabilities = this.section(rows, ['LONG_TERM_LIABILITY', 'CURRENT_LIABILITY', 'DUTIES_TAXES', 'PROVISIONS']);
    const capital = this.section(rows, ['CAPITAL', 'RESERVES']);

    // Everything the income and expense accounts have ever netted to, plus the
    // stock now on hand that no expense has been reversed for.
    const incomeLessExpense = rows.reduce((sum, r) => {
      if (r.type === 'INCOME') return sum + r.creditPaise - r.debitPaise;
      if (r.type === 'EXPENSE') return sum - (r.debitPaise - r.creditPaise);
      return sum;
    }, 0);
    const retainedPaise = incomeLessExpense + stock.valuePaise - broughtIn.valuePaise;

    const capitalSection = capital.find((s) => s.group === 'CAPITAL');
    if (broughtIn.valuePaise !== 0) {
      capitalSection.accounts.push({ accountId: null, code: null, name: 'Opening Stock brought in at go-live', amountPaise: broughtIn.valuePaise });
      capitalSection.totalPaise += broughtIn.valuePaise;
    }
    const reserves = capital.find((s) => s.group === 'RESERVES');
    reserves.accounts.push({ accountId: null, code: null, name: 'Profit & Loss Account', amountPaise: retainedPaise });
    reserves.totalPaise += retainedPaise;

    const totalAssetsPaise = assets.reduce((s, g) => s + g.totalPaise, 0);
    const totalLiabilitiesPaise = liabilities.reduce((s, g) => s + g.totalPaise, 0);
    const totalCapitalPaise = capital.reduce((s, g) => s + g.totalPaise, 0);

    return {
      asOf: date,
      factoryId: factoryId || null,
      assets,
      liabilities,
      capital,
      totalAssetsPaise,
      totalLiabilitiesPaise,
      totalCapitalPaise,
      totalLiabilitiesAndCapitalPaise: totalLiabilitiesPaise + totalCapitalPaise,
      // Zero unless something posted outside a balanced journal.
      differencePaise: totalAssetsPaise - (totalLiabilitiesPaise + totalCapitalPaise),
      stockValuation: { basis: 'STANDARD_COST', unvaluedProducts: stock.unvaluedProducts, datedBy: 'RECORDED_AT' },
    };
  }
}

module.exports = { FinancialStatementsService };
