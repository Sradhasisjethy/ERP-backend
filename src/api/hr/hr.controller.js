const { asyncHandler } = require('../../core/asyncHandler');
const { HrService } = require('./hr.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { assertCanUseFactory } = require('../../core/salesScope');

const listLeaveTypes = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.listLeaveTypes({ includeInactive: req.query.includeInactive === 'true' }), 'Leave types retrieved');
});

const createLeaveType = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.createLeaveType(req.body), 'Leave type created', 201);
});

const updateLeaveType = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.updateLeaveType(req.params.id, req.body), 'Leave type updated');
});

const listLeaveRequests = asyncHandler(async (req, res) => {
  const { page, limit, employeeId, status, from, to } = req.query;
  sendList(res, req, await HrService.listLeaveRequests(Number(page), Number(limit), { employeeId, status, from, to }), 'Leave requests retrieved');
});

const getLeaveRequest = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.getLeaveRequest(req.params.id), 'Leave request retrieved');
});

const applyForLeave = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.applyForLeave(req.body), 'Leave applied for', 201);
});

const decideLeave = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.decideLeave(req.params.id, req.body), `Leave ${req.body.status.toLowerCase()}`);
});

const cancelLeave = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.cancelLeave(req.params.id), 'Leave request cancelled');
});

const leaveBalances = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.leaveBalances(req.query.employeeId, req.query.date), 'Leave balances retrieved');
});

const attendanceRoster = asyncHandler(async (req, res) => {
  sendSuccess(res, await HrService.attendanceRoster(req.query.date), 'Attendance roster retrieved');
});

const markAttendance = asyncHandler(async (req, res) => {
  // BR-29: attendance may be attributed to a site, and only to one the user has.
  if (req.body.factoryId) await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, await HrService.markAttendance(req.body), 'Attendance marked', 201);
});

const listAttendance = asyncHandler(async (req, res) => {
  const { page, limit, employeeId, from, to, status } = req.query;
  sendList(res, req, await HrService.listAttendance(Number(page), Number(limit), { employeeId, from, to, status }), 'Attendance retrieved');
});

const attendanceSummary = asyncHandler(async (req, res) => {
  const { from, to, employeeId } = req.query;
  sendSuccess(res, await HrService.attendanceSummary({ from, to, employeeId }), 'Attendance summary retrieved');
});

module.exports = {
  listLeaveTypes, createLeaveType, updateLeaveType,
  listLeaveRequests, getLeaveRequest, applyForLeave, decideLeave, cancelLeave, leaveBalances,
  attendanceRoster, markAttendance, listAttendance, attendanceSummary,
};
