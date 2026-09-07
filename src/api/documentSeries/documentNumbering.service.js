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

    // Both steps run on the CALLER'S connection, inside the caller's transaction.
    //
    // Two earlier shapes were wrong in opposite directions, and the fix has to
    // avoid both:
    //
    //   a) Creating the series row with a plain INSERT inside this transaction.
    //      Concurrent requests for a brand-new series all insert, all but one
    //      hit the unique index, and that violation marks the caller's
    //      transaction ABORTED at the Postgres level — every later statement
    //      then fails with "current transaction is aborted".
    //
    //   b) Creating it on a separate connection to keep the violation out of
    //      the caller's transaction. That deadlocks under load: the pool holds
    //      max 5 connections, each in-flight request already owns one for its
    //      transaction, and asking for a second one that only a committing
    //      sibling could release means N concurrent requests wait out the full
    //      60s acquire timeout. Ten concurrent creations returned four.
    //
    // INSERT ... ON CONFLICT DO NOTHING avoids the dilemma outright: it is a
    // single statement on the existing connection that simply never raises, so
    // there is no violation to poison the transaction and no second connection
    // to deadlock on. A concurrent inserter briefly blocks on the index until
    // the winner commits, then proceeds as a no-op — an ordinary row-lock wait.
    const run = async (t) => {
      await this._ensureSeries(documentType, { factoryId, financialYearId, prefix, transaction: t });
      return this._allocateOnce(documentType, { factoryId, financialYearId, transaction: t });
    };
    return transaction ? run(transaction) : sequelize.transaction(run);
  }

  /**
   * Creates the series row if it is missing, as a single non-raising statement
   * on the caller's connection. Safe to call concurrently: the losers insert
   * nothing and carry on.
   */
  static async _ensureSeries(documentType, { factoryId, financialYearId, prefix, transaction }) {
    const existing = await DocumentSeries.findOne({
      where: { documentType, factoryId, financialYearId },
      transaction,
    });
    if (existing) return;

    // `ignoreDuplicates` emits ON CONFLICT DO NOTHING with no inference target,
    // which is what this table needs: the uniqueness is enforced by two PARTIAL
    // indexes (one for factoryId IS NULL, one for NOT NULL), so naming a single
    // conflict target would only cover half the cases.
    await DocumentSeries.bulkCreate(
      [
        {
          tenantId: getTenantId(),
          documentType,
          factoryId,
          financialYearId,
          prefix: await defaultPrefixFor(prefix, documentType, factoryId, transaction),
          nextSequence: 1,
          padding: 4,
        },
      ],
      { ignoreDuplicates: true, transaction }
    );
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
