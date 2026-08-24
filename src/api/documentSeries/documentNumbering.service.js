const { UniqueConstraintError } = require('sequelize');
const { sequelize } = require('../../config/database');
const { DocumentSeries } = require('./documentSeries.model');
const { getTenantId } = require('../../core/tenantContext');

/**
 * Builds the default prefix for a brand-new series.
 *
 * A series is keyed (documentType, factoryId, financialYearId) and its sequence
 * restarts at 1 for every factory — but the unique index on the documents
 * themselves is (tenantId, <number>), i.e. tenant-wide. So a tenant's second
 * factory would allocate `SO/0001` again and be rejected by that index with a
 * bare "A record with these details already exists", naming nothing.
 *
 * The consequence was total for a multi-plant tenant: the first sales order,
 * challan, invoice, receipt, GRN or production entry at the second factory
 * simply could not be created. The workaround was to hand-create ten
 * DocumentSeries rows per factory with distinct prefixes before going live —
 * a setup step nothing enforced, documented, or defaulted.
 *
 * Folding the factory code into the default prefix (`SO/PA/0001`) makes the
 * out-of-the-box behaviour correct while keeping numbers unique tenant-wide,
 * which is also what GST requires of an invoice series. An explicitly
 * configured prefix is still honoured untouched, and existing series rows keep
 * the prefix they already have — this only affects series created from now on.
 */
const defaultPrefixFor = async (prefix, documentType, factoryId, transaction) => {
  const base = prefix || documentType;
  if (!factoryId) return base;

  const { Factory } = require('../factory/factory.model');
  const factory = await Factory.findByPk(factoryId, { attributes: ['code'], transaction });
  const code = factory && factory.code ? String(factory.code).trim().toUpperCase().replace(/\s+/g, '-') : null;
  return code ? `${base}/${code}` : base;
};

/**
 * Allocates the next document number for a given type/factory/financial-year
 * series. Implements BR-31/BR-32: numbers are gap-free per series and only
 * handed out on successful commit, under a database row lock, so concurrent
 * users never receive duplicates.
 */
class DocumentNumberingService {
  static async allocate(documentType, { factoryId = null, financialYearId, prefix, transaction } = {}) {
    if (!financialYearId) {
      throw new Error('DocumentNumberingService.allocate requires financialYearId');
    }

    // Two separate problems, solved separately, because conflating them is
    // what made the earlier attempts wrong.
    //
    // 1. CREATING the series row races: several concurrent requests for a
    //    brand-new series all try to insert it and all but one hit the unique
    //    constraint. Done inside the caller's transaction, that violation marks
    //    the transaction aborted at the Postgres level, and every later
    //    statement fails with "current transaction is aborted" — ten concurrent
    //    creations against a fresh series lost four of them to opaque 500s.
    //
    //    An earlier fix retried inside a SAVEPOINT. That deadlocked: with CLS
    //    active, the nested transaction took its own connection and then waited
    //    on the row lock its own parent held, which can never resolve — two
    //    test suites hung for 15 minutes each.
    //
    //    So the row is ensured up front, in a genuinely independent
    //    transaction that commits immediately and cannot poison or block the
    //    caller. A unique violation there is the expected outcome for the
    //    losers and is simply swallowed: the row exists either way.
    //
    // 2. ALLOCATING the next number is then a pure SELECT ... FOR UPDATE and
    //    UPDATE against a row that is guaranteed to exist, so it cannot raise a
    //    unique violation and needs no retry at all.
    await this._ensureSeries(documentType, { factoryId, financialYearId, prefix });

    const run = (t) => this._allocateOnce(documentType, { factoryId, financialYearId, prefix, transaction: t });
    return transaction ? run(transaction) : sequelize.transaction(run);
  }

  /**
   * Creates the series row if it is missing, on its own connection.
   * Never throws for a concurrent creation — that is the normal path for every
   * request but the winner.
   */
  static async _ensureSeries(documentType, { factoryId, financialYearId, prefix }) {
    const tenantId = getTenantId();
    const existing = await DocumentSeries.findOne({ where: { documentType, factoryId, financialYearId } });
    if (existing) return;

    try {
      await DocumentSeries.create({
        tenantId,
        documentType,
        factoryId,
        financialYearId,
        prefix: await defaultPrefixFor(prefix, documentType, factoryId),
        nextSequence: 1,
        padding: 4,
      });
    } catch (error) {
      // Someone else created it first. That is the expected outcome here.
      if (!(error instanceof UniqueConstraintError)) throw error;
    }
  }

  static async _allocateOnce(documentType, { factoryId, financialYearId, transaction }) {
    // The row is guaranteed to exist by _ensureSeries, so this is a pure
    // read-lock-increment with no failure mode that could abort the caller's
    // transaction.
    const series = await DocumentSeries.findOne({
      where: { documentType, factoryId, financialYearId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!series) throw new Error(`Document series vanished for ${documentType}`);

    const sequenceNumber = series.nextSequence;
    await series.update({ nextSequence: sequenceNumber + 1 }, { transaction });

    const documentNumber = `${series.prefix}/${String(sequenceNumber).padStart(series.padding, '0')}`;
    return { documentNumber, sequenceNumber };
  }
}

module.exports = { DocumentNumberingService };
