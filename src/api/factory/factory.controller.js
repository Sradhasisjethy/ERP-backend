const { Op } = require('sequelize');
const { asyncHandler } = require('../../core/asyncHandler');
const { FactoryService } = require('./factory.service');
const { Factory } = require('./factory.model');
const { FinancialYear } = require('./financialYear.model');
const { hasPermission } = require('../../middlewares/authorize');
const { assertCanUseFactory } = require('../../core/salesScope');
const { ForbiddenError, NotFoundError } = require('../../core/AppError');
const { sendSuccess, sendList } = require('../../utils/response');

/**
 * The fields that loosen or tighten a plant's controls — negative stock and
 * cash (BR-20/21), the QC hold, and the variance and dispatch tolerances. They
 * sit on the same form as the plant's name and address, so FACTORY_MODIFY
 * alone used to be enough to switch them off. They now need the named grant.
 */
const POLICY_FIELDS = ['allowNegativeStock', 'allowNegativeCash', 'qcHoldEnabled', 'varianceThresholdPercent', 'dispatchTolerancePercent'];

// DECIMAL columns come back as strings ("5.00"), so compare as numbers.
const sameValue = (a, b) => (typeof a === 'boolean' || typeof b === 'boolean' ? !!a === !!b : Number(a) === Number(b));

/**
 * Refuses a body that *changes* a policy field. Compared against the current
 * value (or the column default on create) rather than mere presence, because
 * the factory form always sends every checkbox: re-saving it unchanged, or
 * creating a plant with the defaults, must keep working for FACTORY_MODIFY.
 */
const assertMayChangePolicy = (req, current) => {
  if (hasPermission(req.user, 'FACTORY_POLICY_MODIFY')) return;
  const changed = POLICY_FIELDS.filter((f) => req.body[f] !== undefined && !sameValue(req.body[f], current[f]));
  if (changed.length) {
    throw new ForbiddenError(`Changing ${changed.join(', ')} needs the "Change location policies" permission`);
  }
};

const columnDefaults = () =>
  Object.fromEntries(POLICY_FIELDS.map((f) => [f, Factory.getAttributes()[f].defaultValue]));

const CLOSING_STATUSES = ['SOFT_CLOSED', 'CLOSED'];

/**
 * FINANCIAL_YEAR_CLOSE for any status change that closes, reopens or rolls
 * over a year. Soft-closing a year stops nothing (see LedgerService's posting
 * guard), but CLOSED is permanent and making a new year current soft-closes
 * the old one, so neither is a FACTORY_MODIFY-sized decision.
 *
 * `fy` is null on create. Activating a year is only a rollover when some other
 * year is current — a tenant's very first year has nothing to close.
 */
const assertMayChangeYearStatus = async (req, fy, targetStatus) => {
  if (!targetStatus || hasPermission(req.user, 'FINANCIAL_YEAR_CLOSE')) return;
  const from = fy ? fy.status : null;
  if (from === targetStatus && (targetStatus !== 'ACTIVE' || fy.isCurrent)) return;

  const deny = () => {
    throw new ForbiddenError('Closing, reopening or rolling over a financial year needs the "Close, reopen and roll over financial years" permission');
  };
  if (CLOSING_STATUSES.includes(targetStatus)) deny();
  if (from === 'SOFT_CLOSED') deny(); // reopening, to ACTIVE or back to PLANNED
  if (targetStatus === 'ACTIVE') {
    const otherCurrent = await FinancialYear.count({ where: { isCurrent: true, ...(fy ? { id: { [Op.ne]: fy.id } } : {}) } });
    if (otherCurrent > 0) deny();
  }
};

const loadYear = async (id) => {
  const fy = await FinancialYear.findByPk(id);
  if (!fy) throw new NotFoundError('Financial year not found');
  return fy;
};

// Factories
const listFactories = asyncHandler(async (req, res) => {
  const { page, limit, organizationId, search, status } = req.query;
  const data = await FactoryService.listFactories(Number(page), Number(limit), organizationId, search, status);
  sendList(res, req, data, 'Factories retrieved successfully');
});

const getFactory = asyncHandler(async (req, res) => {
  const data = await FactoryService.getFactory(req.params.id);
  sendSuccess(res, data, 'Factory retrieved successfully');
});

const createFactory = asyncHandler(async (req, res) => {
  assertMayChangePolicy(req, columnDefaults());
  const data = await FactoryService.createFactory(req.body);
  sendSuccess(res, data, 'Factory created successfully', 201);
});

const updateFactory = asyncHandler(async (req, res) => {
  assertMayChangePolicy(req, await FactoryService.getFactory(req.params.id));
  const data = await FactoryService.updateFactory(req.params.id, req.body);
  sendSuccess(res, data, 'Factory updated successfully');
});

const deleteFactory = asyncHandler(async (req, res) => {
  await FactoryService.deleteFactory(req.params.id);
  sendSuccess(res, null, 'Factory deleted successfully');
});

// Financial Years
const listFinancialYears = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const pageNum = Number(page) || 1;
  const limitNum = Number(limit) || 10;
  const data = await FactoryService.listFinancialYears(pageNum, limitNum, { search });
  sendList(res, req, data, 'Financial years retrieved successfully');
});

const getCurrentFinancialYear = asyncHandler(async (req, res) => {
  const data = await FactoryService.getCurrentFinancialYear();
  sendSuccess(res, data, 'Current financial year retrieved successfully');
});

const createFinancialYear = asyncHandler(async (req, res) => {
  // Mirrors the service: isCurrent alone means ACTIVE, which soft-closes the
  // current year.
  await assertMayChangeYearStatus(req, null, req.body.status || (req.body.isCurrent ? 'ACTIVE' : null));
  const data = await FactoryService.createFinancialYear(req.body);
  sendSuccess(res, data, 'Financial year created successfully', 201);
});

const updateFinancialYear = asyncHandler(async (req, res) => {
  const fy = await loadYear(req.params.id);
  // The service routes a status change through updateStatus and treats
  // isCurrent: true as activation, so both are checked as transitions.
  await assertMayChangeYearStatus(req, fy, req.body.status || (req.body.isCurrent ? 'ACTIVE' : null));
  const data = await FactoryService.updateFinancialYear(req.params.id, req.body);
  sendSuccess(res, data, 'Financial year updated successfully');
});

const deleteFinancialYear = asyncHandler(async (req, res) => {
  await FactoryService.deleteFinancialYear(req.params.id);
  sendSuccess(res, null, 'Financial year deleted successfully');
});

const updateFinancialYearStatus = asyncHandler(async (req, res) => {
  await assertMayChangeYearStatus(req, await loadYear(req.params.id), req.body.status);
  const data = await FactoryService.updateStatus(req.params.id, req.body.status);
  sendSuccess(res, data, 'Financial year status updated successfully');
});

const getFinancialYearPeriods = asyncHandler(async (req, res) => {
  const data = await FactoryService.getFinancialYearPeriods(req.params.id);
  sendSuccess(res, data, 'Financial year periods retrieved successfully');
});

const getCloseChecklist = asyncHandler(async (req, res) => {
  const data = await FactoryService.getCloseChecklist(req.params.id);
  sendSuccess(res, data, 'Year-end close checklist retrieved successfully');
});

const setCurrentFinancialYear = asyncHandler(async (req, res) => {
  await assertMayChangeYearStatus(req, await loadYear(req.params.id), 'ACTIVE');
  const data = await FactoryService.setCurrentFinancialYear(req.params.id);
  sendSuccess(res, data, 'Current financial year updated successfully');
});

// User <-> Factory assignment
const listAssignedUsers = asyncHandler(async (req, res) => {
  const data = await FactoryService.listAssignedUsers(req.params.id);
  sendSuccess(res, data, 'Assigned users retrieved successfully');
});

const assignUser = asyncHandler(async (req, res) => {
  // FACTORY_CREATE says you may set up plants, not that you may join any of
  // them: without this a plant-restricted holder could assign themselves to
  // every plant and so widen their own BR-29 scope.
  await assertCanUseFactory(req, req.params.id);
  const data = await FactoryService.assignUser(req.params.id, req.body.userId);
  sendSuccess(res, data, 'User assigned to factory successfully', 201);
});

const unassignUser = asyncHandler(async (req, res) => {
  await FactoryService.unassignUser(req.params.id, req.params.userId);
  sendSuccess(res, null, 'User unassigned from factory successfully');
});

module.exports = {
  listFactories,
  getFactory,
  createFactory,
  updateFactory,
  deleteFactory,
  listFinancialYears,
  getCurrentFinancialYear,
  createFinancialYear,
  updateFinancialYear,
  updateFinancialYearStatus,
  getFinancialYearPeriods,
  getCloseChecklist,
  deleteFinancialYear,
  setCurrentFinancialYear,
  listAssignedUsers,
  assignUser,
  unassignUser,
};
