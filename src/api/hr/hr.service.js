const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../../config/database');
const { LeaveType, LeaveRequest, StaffAttendance } = require('./hr.model');
const { User } = require('../users/user.model');
const { NotFoundError, ValidationError, ConflictError, ForbiddenError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { env } = require('../../config/env');
const { isoDateInZone } = require('../../utils/dateDisplay');
const { EmployeeStatus } = require('../../utils/constants');

/**
 * Leave and attendance for salaried staff.
 *
 * Two rules do most of the work here:
 *
 *  - **A person cannot be on leave twice.** Overlapping pending or approved
 *    requests are refused, because a balance computed over double-counted days
 *    is worse than no balance at all.
 *  - **Nobody decides their own leave.** Approving is a separate grant, and
 *    even holding it does not let someone approve a request they raised.
 *
 * Leave years follow the Indian financial year (1 April – 31 March), the same
 * year the rest of the system reports on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const asDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const dayCount = (from, to) => Math.round((asDate(to) - asDate(from)) / DAY_MS) + 1;
const today = () => isoDateInZone(new Date(), env.APP_TIMEZONE);

/** 1 April – 31 March window containing `date`. */
const leaveYearOf = (date) => {
  const d = asDate(date);
  const year = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { from: `${year}-04-01`, to: `${year + 1}-03-31`, label: `${year}-${String((year + 1) % 100).padStart(2, '0')}` };
};

const num = (v) => (v === null || v === undefined ? null : Number(v));

class HrService {
  // --- Leave types ---------------------------------------------------------

  static async listLeaveTypes({ includeInactive = false } = {}) {
    const where = includeInactive ? {} : { isActive: true };
    const rows = await LeaveType.findAll({ where, order: [['name', 'ASC']] });
    return rows.map((t) => ({ ...t.toJSON(), daysPerYear: Number(t.daysPerYear) }));
  }

  static async createLeaveType({ code, name, daysPerYear = 0, isPaid = true, description }) {
    const trimmed = String(code).trim().toUpperCase();
    const existing = await LeaveType.findOne({ where: { code: trimmed } });
    if (existing) throw new ConflictError(`A leave type with code ${trimmed} already exists`);
    const created = await LeaveType.create({ code: trimmed, name: String(name).trim(), daysPerYear, isPaid, description: description || null });
    return { ...created.toJSON(), daysPerYear: Number(created.daysPerYear) };
  }

  static async updateLeaveType(id, input) {
    const type = await LeaveType.findByPk(id);
    if (!type) throw new NotFoundError('Leave type not found');
    const changes = {};
    for (const field of ['name', 'daysPerYear', 'isPaid', 'isActive', 'description']) {
      if (input[field] !== undefined) changes[field] = input[field];
    }
    await type.update(changes);
    return { ...type.toJSON(), daysPerYear: Number(type.daysPerYear) };
  }

  // --- Leave requests ------------------------------------------------------

  static async assertEmployee(employeeId) {
    const employee = await User.findByPk(employeeId, { attributes: ['id', 'firstName', 'lastName', 'status'] });
    if (!employee) throw new NotFoundError('Employee not found');
    if (employee.status === EmployeeStatus.TERMINATED) {
      const name = [employee.firstName, employee.lastName].filter(Boolean).join(' ');
      throw new ValidationError(`${name} has left — leave and attendance cannot be recorded against them`);
    }
    return employee;
  }

  static async applyForLeave({ employeeId, leaveTypeId, fromDate, toDate, days, reason }) {
    if (toDate < fromDate) throw new ValidationError('Leave cannot end before it starts');
    await this.assertEmployee(employeeId);
    const type = await LeaveType.findByPk(leaveTypeId);
    if (!type || !type.isActive) throw new NotFoundError('Leave type not found');

    const span = dayCount(fromDate, toDate);
    const requested = days === undefined || days === null ? span : Number(days);
    if (requested <= 0) throw new ValidationError('Leave must be at least half a day');
    if (requested > span) throw new ValidationError(`${fromDate} to ${toDate} is ${span} day(s) — you cannot apply for ${requested}`);

    const clash = await LeaveRequest.findOne({
      where: {
        employeeId,
        status: { [Op.in]: ['PENDING', 'APPROVED'] },
        fromDate: { [Op.lte]: toDate },
        toDate: { [Op.gte]: fromDate },
      },
    });
    if (clash) {
      throw new ConflictError(`This overlaps leave already applied for from ${clash.fromDate} to ${clash.toDate}`);
    }

    const created = await LeaveRequest.create({
      employeeId, leaveTypeId, fromDate, toDate, days: requested,
      reason: reason || null, status: 'PENDING', createdBy: getUserId() || null,
    });
    return this.getLeaveRequest(created.id);
  }

  static async getLeaveRequest(id) {
    const request = await LeaveRequest.findByPk(id, {
      include: [
        { model: LeaveType, as: 'leaveType', attributes: ['id', 'code', 'name', 'isPaid'] },
        { model: User, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'] },
      ],
    });
    if (!request) throw new NotFoundError('Leave request not found');
    return { ...request.toJSON(), days: Number(request.days) };
  }

  static async listLeaveRequests(page, limit, { employeeId, status, from, to } = {}) {
    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (from) where.toDate = { [Op.gte]: from };
    if (to) where.fromDate = { ...(where.fromDate || {}), [Op.lte]: to };

    const { rows, count } = await LeaveRequest.findAndCountAll({
      where, limit, offset: (page - 1) * limit,
      include: [
        { model: LeaveType, as: 'leaveType', attributes: ['id', 'code', 'name', 'isPaid'] },
        { model: User, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'] },
      ],
      order: [['fromDate', 'DESC']],
    });
    return { rows: rows.map((r) => ({ ...r.toJSON(), days: Number(r.days) })), count };
  }

  /**
   * Approve or reject. The decider may not be the applicant — the one rule
   * that makes an approval mean anything.
   */
  static async decideLeave(id, { status, note }) {
    const request = await LeaveRequest.findByPk(id);
    if (!request) throw new NotFoundError('Leave request not found');
    if (request.status !== 'PENDING') throw new ValidationError(`This request is already ${request.status.toLowerCase()}`);
    if (!['APPROVED', 'REJECTED'].includes(status)) throw new ValidationError('A decision is either APPROVED or REJECTED');
    if (status === 'REJECTED' && !String(note || '').trim()) throw new ValidationError('Say why the leave was refused');

    const decider = getUserId();
    if (decider && decider === request.employeeId) {
      throw new ForbiddenError('You cannot decide your own leave request');
    }

    await request.update({ status, decidedBy: decider || null, decidedAt: new Date(), decisionNote: note ? String(note).trim() : null });
    return this.getLeaveRequest(id);
  }

  /** Withdrawing an application. Approved leave can be cancelled up to the day it starts. */
  static async cancelLeave(id) {
    const request = await LeaveRequest.findByPk(id);
    if (!request) throw new NotFoundError('Leave request not found');
    if (['CANCELLED', 'REJECTED'].includes(request.status)) throw new ValidationError(`This request is already ${request.status.toLowerCase()}`);
    if (request.status === 'APPROVED' && String(request.fromDate) < today()) {
      throw new ValidationError('This leave has already started — it can no longer be cancelled');
    }
    await request.update({ status: 'CANCELLED' });
    return this.getLeaveRequest(id);
  }

  /** Days allowed, taken and left, per leave type, for the leave year containing `date`. */
  static async leaveBalances(employeeId, date = today()) {
    await this.assertEmployee(employeeId);
    const year = leaveYearOf(date);
    const types = await this.listLeaveTypes();

    const taken = await LeaveRequest.findAll({
      attributes: ['leaveTypeId', [fn('SUM', col('days')), 'days']],
      where: {
        employeeId,
        status: 'APPROVED',
        fromDate: { [Op.lte]: year.to },
        toDate: { [Op.gte]: year.from },
      },
      group: ['leaveTypeId'],
      raw: true,
    });
    const pending = await LeaveRequest.findAll({
      attributes: ['leaveTypeId', [fn('SUM', col('days')), 'days']],
      where: {
        employeeId,
        status: 'PENDING',
        fromDate: { [Op.lte]: year.to },
        toDate: { [Op.gte]: year.from },
      },
      group: ['leaveTypeId'],
      raw: true,
    });
    const takenBy = Object.fromEntries(taken.map((t) => [t.leaveTypeId, Number(t.days)]));
    const pendingBy = Object.fromEntries(pending.map((t) => [t.leaveTypeId, Number(t.days)]));

    return {
      employeeId,
      leaveYear: year.label,
      from: year.from,
      to: year.to,
      balances: types.map((type) => {
        const used = takenBy[type.id] || 0;
        return {
          leaveTypeId: type.id,
          code: type.code,
          name: type.name,
          isPaid: type.isPaid,
          allowedDays: type.daysPerYear,
          takenDays: used,
          pendingDays: pendingBy[type.id] || 0,
          // Unlimited types (no yearly quota) have no remaining figure to give.
          remainingDays: type.daysPerYear > 0 ? Number((type.daysPerYear - used).toFixed(1)) : null,
        };
      }),
    };
  }

  // --- Attendance ----------------------------------------------------------

  /**
   * Everyone who should be marked for a day, with what is already recorded and
   * what the leave register suggests — so a person on approved leave is not
   * marked absent by hand.
   */
  static async attendanceRoster(date) {
    const employees = await User.findAll({
      where: { status: { [Op.ne]: EmployeeStatus.TERMINATED }, isSystem: false },
      attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'departmentId'],
      order: [['firstName', 'ASC']],
    });
    const marked = await StaffAttendance.findAll({ where: { attendanceDate: date } });
    const markedBy = Object.fromEntries(marked.map((m) => [m.employeeId, m.toJSON()]));

    const onLeave = await LeaveRequest.findAll({
      where: { status: 'APPROVED', fromDate: { [Op.lte]: date }, toDate: { [Op.gte]: date } },
      include: [{ model: LeaveType, as: 'leaveType', attributes: ['code', 'name'] }],
    });
    const leaveBy = Object.fromEntries(onLeave.map((l) => [l.employeeId, l.leaveType]));

    return {
      date,
      rows: employees.map((e) => ({
        employeeId: e.id,
        name: [e.firstName, e.lastName].filter(Boolean).join(' '),
        employeeCode: e.employeeCode,
        attendance: markedBy[e.id] || null,
        approvedLeave: leaveBy[e.id] ? { code: leaveBy[e.id].code, name: leaveBy[e.id].name } : null,
        suggestedStatus: markedBy[e.id]?.status || (leaveBy[e.id] ? 'ON_LEAVE' : 'PRESENT'),
      })),
    };
  }

  /** Marks a day for several people at once; marking again corrects the earlier mark. */
  static async markAttendance({ attendanceDate, factoryId, entries }) {
    if (!entries?.length) throw new ValidationError('Nobody to mark');
    return sequelize.transaction(async (transaction) => {
      const saved = [];
      for (const entry of entries) {
        await this.assertEmployee(entry.employeeId);
        const existing = await StaffAttendance.findOne({
          where: { employeeId: entry.employeeId, attendanceDate },
          transaction,
        });
        const values = {
          employeeId: entry.employeeId,
          attendanceDate,
          factoryId: factoryId || null,
          status: entry.status,
          inTime: entry.inTime || null,
          outTime: entry.outTime || null,
          note: entry.note || null,
          markedBy: getUserId() || null,
        };
        if (existing) {
          await existing.update(values, { transaction });
          saved.push(existing);
        } else {
          saved.push(await StaffAttendance.create(values, { transaction }));
        }
      }
      return { attendanceDate, marked: saved.length };
    });
  }

  static async listAttendance(page, limit, { employeeId, from, to, status } = {}) {
    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (from || to) {
      where.attendanceDate = {};
      if (from) where.attendanceDate[Op.gte] = from;
      if (to) where.attendanceDate[Op.lte] = to;
    }
    const { rows, count } = await StaffAttendance.findAndCountAll({
      where, limit, offset: (page - 1) * limit,
      include: [{ model: User, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'] }],
      order: [['attendanceDate', 'DESC']],
    });
    return { rows: rows.map((r) => r.toJSON()), count };
  }

  /** Present / absent / leave day counts per person over a period — the payroll input. */
  static async attendanceSummary({ from, to, employeeId }) {
    const where = { attendanceDate: { [Op.gte]: from, [Op.lte]: to } };
    if (employeeId) where.employeeId = employeeId;

    const rows = await StaffAttendance.findAll({
      attributes: ['employeeId', 'status', [fn('COUNT', col('id')), 'days']],
      where,
      group: ['employeeId', 'status'],
      raw: true,
    });
    const employees = await User.findAll({ attributes: ['id', 'firstName', 'lastName', 'employeeCode'] });
    const nameOf = Object.fromEntries(employees.map((e) => [e.id, { name: [e.firstName, e.lastName].filter(Boolean).join(' '), employeeCode: e.employeeCode }]));

    const byEmployee = new Map();
    for (const row of rows) {
      if (!byEmployee.has(row.employeeId)) {
        byEmployee.set(row.employeeId, {
          employeeId: row.employeeId, ...nameOf[row.employeeId],
          PRESENT: 0, ABSENT: 0, HALF_DAY: 0, ON_LEAVE: 0, WEEKLY_OFF: 0, HOLIDAY: 0,
        });
      }
      byEmployee.get(row.employeeId)[row.status] = Number(row.days);
    }
    return {
      from,
      to,
      rows: [...byEmployee.values()].map((r) => ({
        ...r,
        // Days actually worked. Whether a leave day is paid depends on the
        // leave type, which this register does not carry, so leave is reported
        // separately rather than folded into a figure that implies payment.
        workedDays: r.PRESENT + r.HALF_DAY * 0.5,
        leaveDays: r.ON_LEAVE,
        offDays: r.WEEKLY_OFF + r.HOLIDAY,
      })),
    };
  }
}

module.exports = { HrService, leaveYearOf, num };
