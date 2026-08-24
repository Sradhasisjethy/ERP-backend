const { asyncHandler } = require('../../core/asyncHandler');
const { sequelize } = require('../../config/database');
const { StockLedgerService } = require('./stockLedger.service');
const { StockAdjustmentService } = require('./stockAdjustment.service');
const { ReservationService } = require('./reservation.service');
const { scopeListToFactories, assertCanUseFactory } = require('../../core/salesScope');
const { sendSuccess, sendList } = require('../../utils/response');

const listLots = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, status, search, sortBy, sortDir } = req.query;
  // BR-29: stock is location data. Without this every factory's lots came back.
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await StockLedgerService.listLots(Number(page), Number(limit), { productId, status, search, sortBy, sortDir, baseWhere });
  sendList(res, req, data, 'Stock lots retrieved successfully');
});

const listLedgerEntries = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, lotId, movementType, search, sortBy, sortDir } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await StockLedgerService.listLedgerEntries(Number(page), Number(limit), { productId, lotId, movementType, search, sortBy, sortDir, baseWhere });
  sendList(res, req, data, 'Stock ledger entries retrieved successfully');
});

const getStockBalance = asyncHandler(async (req, res) => {
  const { factoryId, productId } = req.query;
  await assertCanUseFactory(req, factoryId);

  // The full picture, not one number. `balance` used to be the only field and
  // it counted AVAILABLE lots only — so a warehouse holding 70 units that were
  // still curing was told its balance was 0, with no way to ask what was
  // physically on the floor. That number disagrees with the stock ledger by
  // construction, which is exactly what a reconciliation is supposed to catch.
  //
  // `balance` is kept, unchanged, as the sellable figure callers already rely
  // on; onHand/curing/reserved/inTransit make the rest of the position
  // explicit so the two can never be confused for each other again.
  const data = await sequelize.transaction(async (t) => {
    const availability = await ReservationService.getAvailability(factoryId, productId, t);
    const balance = await StockLedgerService.getStockBalance(factoryId, productId, t);
    return { ...availability, balance };
  });

  sendSuccess(res, { factoryId, productId, ...data }, 'Stock balance retrieved successfully');
});

// --- M22: physical stock count corrections ---
const listAdjustments = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, lotId, sortBy, sortDir } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await StockAdjustmentService.list(Number(page), Number(limit), { productId, lotId, sortBy, sortDir, baseWhere });
  sendList(res, req, data, 'Stock adjustments retrieved successfully');
});

const createAdjustment = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  const data = await StockAdjustmentService.create(req.body);
  sendSuccess(res, data, 'Stock adjustment recorded successfully', 201);
});

const releaseLotEarly = asyncHandler(async (req, res) => {
  const data = await StockLedgerService.releaseLotEarly(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Lot released early successfully');
});

module.exports = { listLots, listLedgerEntries, getStockBalance, releaseLotEarly, listAdjustments, createAdjustment };
