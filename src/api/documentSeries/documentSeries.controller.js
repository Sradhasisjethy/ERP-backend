const { asyncHandler } = require('../../core/asyncHandler');
const { DocumentSeriesService } = require('./documentSeries.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listDocumentSeries = asyncHandler(async (req, res) => {
  const { page, limit, documentType, factoryId, financialYearId, search } = req.query;
  const data = await DocumentSeriesService.list(Number(page), Number(limit), { documentType, factoryId, financialYearId, search });
  sendList(res, req, data, 'Document series retrieved successfully');
});

module.exports = { listDocumentSeries };
