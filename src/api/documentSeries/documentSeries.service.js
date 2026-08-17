const { DocumentSeries } = require('./documentSeries.model');
const { searchWhere } = require('../../utils/pagination');

class DocumentSeriesService {
  // Read-only view for admins to see current numbering state — series rows
  // themselves are only ever mutated by documentNumbering.service.js.
  static async list(page, limit, { documentType, factoryId, financialYearId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (documentType) where.documentType = documentType;
    if (factoryId) where.factoryId = factoryId;
    if (financialYearId) where.financialYearId = financialYearId;

    if (search) Object.assign(where, searchWhere(search, ['documentType', 'prefix']));
    return DocumentSeries.findAndCountAll({ where, limit, offset, order: [['documentType', 'ASC']] });
  }
}

module.exports = { DocumentSeriesService };
