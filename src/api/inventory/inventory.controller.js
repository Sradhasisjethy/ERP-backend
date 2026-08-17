const { asyncHandler } = require('../../core/asyncHandler');
const { sequelize } = require('../../config/database');
const { StockLedgerService } = require('./stockLedger.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listLots = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, status, search } = req.query;
  const data = await StockLedgerService.listLots(Number(page), Number(limit), { factoryId, productId, status, search });
  sendList(res, req, data, 'Stock lots retrieved successfully');
});

const listLedgerEntries = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, lotId, movementType, search } = req.query;
  const data = await StockLedgerService.listLedgerEntries(Number(page), Number(limit), { factoryId, productId, lotId, movementType, search });
  sendList(res, req, data, 'Stock ledger entries retrieved successfully');
});

const getStockBalance = asyncHandler(async (req, res) => {
  const { factoryId, productId } = req.query;
  const balance = await sequelize.transaction((t) => StockLedgerService.getStockBalance(factoryId, productId, t));
  sendSuccess(res, { factoryId, productId, balance }, 'Stock balance retrieved successfully');
});

const releaseLotEarly = asyncHandler(async (req, res) => {
  const data = await StockLedgerService.releaseLotEarly(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Lot released early successfully');
});

module.exports = { listLots, listLedgerEntries, getStockBalance, releaseLotEarly };
