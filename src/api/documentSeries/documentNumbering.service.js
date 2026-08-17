const { UniqueConstraintError } = require('sequelize');
const { sequelize } = require('../../config/database');
const { DocumentSeries } = require('./documentSeries.model');
const { getTenantId } = require('../../core/tenantContext');

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

    const run = (t) => this._allocateOnce(documentType, { factoryId, financialYearId, prefix, transaction: t });

    // The very first allocation for a brand-new series can race two concurrent
    // requests into both attempting to create the DocumentSeries row; the loser
    // hits the unique constraint below and simply retries, which will then find
    // the row the winner created and proceed through the normal locked path.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (transaction) return await run(transaction);
        return await sequelize.transaction(run);
      } catch (error) {
        if (error instanceof UniqueConstraintError && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error('Failed to allocate document number after retries');
  }

  static async _allocateOnce(documentType, { factoryId, financialYearId, prefix, transaction }) {
    const tenantId = getTenantId();

    let series = await DocumentSeries.findOne({
      where: { documentType, factoryId, financialYearId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!series) {
      series = await DocumentSeries.create(
        {
          tenantId,
          documentType,
          factoryId,
          financialYearId,
          prefix: prefix || documentType,
          nextSequence: 1,
          padding: 4,
        },
        { transaction }
      );
      // Re-fetch under lock so a concurrent allocation for the row we just
      // created is serialized the same way an existing-series allocation is.
      series = await DocumentSeries.findOne({
        where: { id: series.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    }

    const sequenceNumber = series.nextSequence;
    await series.update({ nextSequence: sequenceNumber + 1 }, { transaction });

    const documentNumber = `${series.prefix}/${String(sequenceNumber).padStart(series.padding, '0')}`;
    return { documentNumber, sequenceNumber };
  }
}

module.exports = { DocumentNumberingService };
