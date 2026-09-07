const { Op } = require('sequelize');
const { Factory } = require('./factory.model');
const { FinancialYear } = require('./financialYear.model');
const { UserFactory } = require('./userFactory.model');
const { NotFoundError, ConflictError, ValidationError } = require('../../core/AppError');

const calculate12MonthEndDate = (startDateStr) => {
  const [year, month, day] = startDateStr.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate() - 1));
  return end.toISOString().slice(0, 10);
};

const generate12Periods = (startDateStr, status) => {
  const [startYear, startMonth, startDay] = startDateStr.split('-').map(Number);
  const periods = [];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  for (let i = 0; i < 12; i++) {
    const curMonthIndex = (startMonth - 1 + i) % 12;
    const curYear = startYear + Math.floor((startMonth - 1 + i) / 12);

    const pStart = new Date(Date.UTC(curYear, curMonthIndex, (i === 0 ? startDay : 1)));
    const pEnd = (i === 11)
      ? new Date(Date.UTC(startYear + 1, startMonth - 1, startDay - 1))
      : new Date(Date.UTC(curYear, curMonthIndex + 1, 0));

    let periodStatus = 'Open';
    if (status === 'PLANNED') periodStatus = 'Planned';
    else if (status === 'SOFT_CLOSED') periodStatus = 'Adjustments Only';
    else if (status === 'CLOSED') periodStatus = 'Closed & Locked';
    else if (status === 'ACTIVE') periodStatus = 'Active / Open';

    periods.push({
      periodNumber: i + 1,
      periodCode: `M${String(i + 1).padStart(2, '0')}`,
      monthName: `${monthNames[curMonthIndex]} ${curYear}`,
      startDate: pStart.toISOString().slice(0, 10),
      endDate: pEnd.toISOString().slice(0, 10),
      status: periodStatus,
    });
  }
  return periods;
};

class FactoryService {
  // --- Factories ---
  static async listFactories(page, limit, organizationId, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    return Factory.findAndCountAll({ where, limit, offset, order: [['name', 'ASC']] });
  }

  static async getFactory(id) {
    const factory = await Factory.findByPk(id);
    if (!factory) throw new NotFoundError('Factory not found');
    return factory;
  }

  static async createFactory(data) {
    return Factory.create(data);
  }

  static async updateFactory(id, data) {
    const factory = await this.getFactory(id);
    return factory.update(data);
  }

  static async deleteFactory(id) {
    const factory = await this.getFactory(id);
    await factory.destroy();
    return true;
  }

  // --- Financial Years ---
  static async listFinancialYears(page, limit) {
    const offset = (page - 1) * limit;
    return FinancialYear.findAndCountAll({ limit, offset, order: [['startDate', 'DESC']] });
  }

  static async getCurrentFinancialYear() {
    const fy = await FinancialYear.findOne({ where: { isCurrent: true } });
    if (!fy) throw new NotFoundError('No current financial year is configured');
    return fy;
  }

  static async createFinancialYear(data) {
    const startDate = String(data.startDate).trim();
    if (!startDate) throw new ValidationError('Start date is required');

    const { getTenantId } = require('../../core/tenantContext');
    const tenantId = data.tenantId || getTenantId();

    // Enforce 12-month automated boundary
    const endDate = calculate12MonthEndDate(startDate);
    const status = data.status || (data.isCurrent ? 'ACTIVE' : 'PLANNED');
    const isCurrent = status === 'ACTIVE';

    const fyData = {
      ...data,
      ...(tenantId ? { tenantId } : {}),
      startDate,
      endDate,
      status,
      isCurrent,
    };

    if (isCurrent) {
      return FinancialYear.sequelize.transaction(async (transaction) => {
        await FinancialYear.update({ isCurrent: false, status: 'SOFT_CLOSED' }, { where: { isCurrent: true }, transaction });
        return FinancialYear.create(fyData, { transaction });
      });
    }

    return FinancialYear.create(fyData);
  }

  static async updateFinancialYear(id, data) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    if (fy.status === 'CLOSED') {
      throw new ValidationError('Closed/Audited financial years cannot be modified');
    }

    const updates = { ...data };
    if (updates.startDate) {
      updates.endDate = calculate12MonthEndDate(updates.startDate);
    }

    if (updates.status && updates.status !== fy.status) {
      return this.updateStatus(id, updates.status);
    }

    if (updates.isCurrent) {
      return FinancialYear.sequelize.transaction(async (transaction) => {
        await FinancialYear.update({ isCurrent: false, status: 'SOFT_CLOSED' }, { where: { isCurrent: true }, transaction });
        await fy.update({ ...updates, status: 'ACTIVE', isCurrent: true }, { transaction });
      });
    }

    await fy.update(updates);
    return fy.reload();
  }

  static async updateStatus(id, targetStatus) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    const validStatuses = ['PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED'];
    if (!validStatuses.includes(targetStatus)) {
      throw new ValidationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    if (fy.status === 'CLOSED' && targetStatus !== 'CLOSED') {
      throw new ValidationError('Closed/Audited financial years are permanently locked and cannot be reopened');
    }

    if (targetStatus === 'ACTIVE') {
      await FinancialYear.sequelize.transaction(async (transaction) => {
        await FinancialYear.update(
          { isCurrent: false, status: 'SOFT_CLOSED' },
          { where: { isCurrent: true, id: { [Op.ne]: fy.id } }, transaction }
        );
        await fy.update({ status: 'ACTIVE', isCurrent: true }, { transaction });
      });
      return fy.reload();
    }

    // Changing to PLANNED, SOFT_CLOSED, or CLOSED
    await fy.update({ status: targetStatus, isCurrent: false });
    return fy.reload();
  }

  static async getFinancialYearPeriods(id) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    const periods = generate12Periods(fy.startDate, fy.status);
    return {
      financialYear: fy,
      periods,
    };
  }

  static async getCloseChecklist(id) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    const { DocumentSeries } = require('../documentSeries/documentSeries.model');
    const { SalesInvoice } = require('../invoicing/salesInvoice.model');
    const { SalesOrder } = require('../sales/salesOrder.model');

    const unpostedInvoicesCount = await SalesInvoice.count({
      where: {
        status: 'DRAFT',
        invoiceDate: { [Op.between]: [fy.startDate, fy.endDate] },
      },
    }).catch(() => 0);

    const openOrdersCount = await SalesOrder.count({
      where: {
        status: { [Op.in]: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] },
        orderDate: { [Op.between]: [fy.startDate, fy.endDate] },
      },
    }).catch(() => 0);

    const seriesCount = await DocumentSeries.count({
      where: { financialYearId: fy.id },
    }).catch(() => 0);

    return {
      financialYear: fy,
      checks: [
        {
          key: 'unposted_invoices',
          label: 'Unposted Invoices (Drafts)',
          count: unpostedInvoicesCount,
          passed: unpostedInvoicesCount === 0,
          severity: unpostedInvoicesCount > 0 ? 'WARNING' : 'SUCCESS',
          message: unpostedInvoicesCount > 0
            ? `${unpostedInvoicesCount} draft invoice(s) exist. Review and post or cancel them before permanent closing.`
            : 'All invoices for this fiscal year are posted.',
        },
        {
          key: 'open_orders',
          label: 'Active Sales Orders in Progress',
          count: openOrdersCount,
          passed: openOrdersCount === 0,
          severity: openOrdersCount > 0 ? 'INFO' : 'SUCCESS',
          message: openOrdersCount > 0
            ? `${openOrdersCount} active sales order(s) remain open. These will roll over to the next financial year.`
            : 'No open orders pending fulfillment.',
        },
        {
          key: 'document_series',
          label: 'Document Numbering Sequences',
          count: seriesCount,
          passed: true,
          severity: 'INFO',
          message: `${seriesCount} active series tracked for this year.`,
        },
      ],
      canClose: true,
    };
  }

  static async deleteFinancialYear(id) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    if (fy.status !== 'PLANNED') {
      throw new ValidationError(`Cannot delete financial year with status "${fy.status}". Only Draft / Planned years can be deleted.`);
    }

    const { DocumentSeries } = require('../documentSeries/documentSeries.model');
    const usedSeriesCount = await DocumentSeries.count({
      where: {
        financialYearId: fy.id,
        nextSequence: { [Op.gt]: 1 },
      },
    });

    if (usedSeriesCount > 0) {
      throw new ValidationError('Cannot delete financial year: transactions and document numbers have already been generated in this year.');
    }

    // Clean up any unused empty series
    await DocumentSeries.destroy({ where: { financialYearId: fy.id } }).catch(() => {});
    await fy.destroy();
    return true;
  }

  static async setCurrentFinancialYear(id) {
    return this.updateStatus(id, 'ACTIVE');
  }

  // --- User <-> Factory assignment (BR-29) ---
  static async listAssignedUsers(factoryId) {
    await this.getFactory(factoryId);
    return UserFactory.findAll({ where: { factoryId } });
  }

  static async assignUser(factoryId, userId) {
    await this.getFactory(factoryId);
    const [assignment, created] = await UserFactory.findOrCreate({
      where: { factoryId, userId },
      defaults: { factoryId, userId },
    });
    if (!created) throw new ConflictError('User is already assigned to this factory');
    return assignment;
  }

  static async unassignUser(factoryId, userId) {
    const assignment = await UserFactory.findOne({ where: { factoryId, userId } });
    if (!assignment) throw new NotFoundError('Assignment not found');
    await assignment.destroy();
    return true;
  }
}

module.exports = { FactoryService };
