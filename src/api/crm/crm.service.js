const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { Lead, LeadActivity } = require('./lead.model');
const { User } = require('../users/user.model');
const { Party } = require('../parties/party.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { env } = require('../../config/env');
const { isoDateInZone } = require('../../utils/dateDisplay');

/**
 * Leads and their follow-ups.
 *
 * The status is deliberately not free-running: QUOTED is set by raising a
 * quotation against the lead, and WON by that quotation becoming an order or
 * by converting the lead into a customer. Letting anyone mark a lead "won" by
 * hand is how a pipeline stops meaning anything, so the two statuses that
 * matter are set by what actually happened.
 */

const OPEN_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED'];
const MANUAL_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'LOST'];

const today = () => isoDateInZone(new Date(), env.APP_TIMEZONE);

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const view = (lead) => {
  const json = lead.toJSON();
  return {
    ...json,
    estimatedValuePaise: json.estimatedValuePaise === null ? null : Number(json.estimatedValuePaise),
    isOpen: OPEN_STATUSES.includes(json.status),
    ownerName: json.owner ? [json.owner.firstName, json.owner.lastName].filter(Boolean).join(' ') : null,
  };
};

const OWNER_INCLUDE = { model: User, as: 'owner', attributes: ['id', 'firstName', 'lastName'] };

class CrmService {
  static get SOURCES() {
    return ['WALK_IN', 'PHONE', 'REFERRAL', 'SITE_VISIT', 'TENDER', 'ONLINE', 'EXHIBITION', 'OTHER'];
  }

  static async list(page, limit, { status, ownerId, source, search, openOnly } = {}) {
    const where = {};
    if (status) where.status = status;
    if (openOnly) where.status = { [Op.in]: OPEN_STATUSES };
    if (ownerId) where.ownerId = ownerId;
    if (source) where.source = source;
    if (search) Object.assign(where, searchWhere(search, ['leadNumber', 'name', 'contactName', 'phone', 'email']));

    const { rows, count } = await Lead.findAndCountAll({
      where, limit, offset: (page - 1) * limit,
      include: [OWNER_INCLUDE],
      order: [['createdAt', 'DESC']],
    });
    return { rows: rows.map(view), count };
  }

  static async get(id, transaction) {
    const lead = await Lead.findByPk(id, {
      include: [
        OWNER_INCLUDE,
        { model: Party, as: 'customer', attributes: ['id', 'name'] },
        { model: LeadActivity, as: 'activities', include: [{ model: User, as: 'assignee', attributes: ['id', 'firstName', 'lastName'] }] },
      ],
      order: [[{ model: LeadActivity, as: 'activities' }, 'createdAt', 'DESC']],
      transaction,
    });
    if (!lead) throw new NotFoundError('Lead not found');
    return lead;
  }

  static async getView(id) {
    const lead = await this.get(id);
    const json = view(lead);
    return {
      ...json,
      activities: (json.activities || []).map((a) => ({
        ...a,
        assigneeName: a.assignee ? [a.assignee.firstName, a.assignee.lastName].filter(Boolean).join(' ') : null,
      })),
    };
  }

  static async create(input) {
    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('LEAD', { financialYearId, prefix: 'LD', transaction });

      const lead = await Lead.create(
        {
          leadNumber: documentNumber,
          name: String(input.name).trim(),
          contactName: input.contactName || null,
          phone: input.phone || null,
          email: input.email || null,
          city: input.city || null,
          state: input.state || null,
          source: input.source || 'OTHER',
          status: 'NEW',
          estimatedValuePaise: input.estimatedValuePaise ?? null,
          expectedCloseDate: input.expectedCloseDate || null,
          ownerId: input.ownerId || getUserId() || null,
          requirement: input.requirement || null,
          createdBy: getUserId() || null,
        },
        { transaction }
      );
      return view(await this.get(lead.id, transaction));
    });
  }

  static async update(id, input) {
    const lead = await this.get(id);
    if (['WON', 'LOST'].includes(lead.status) && input.status === undefined) {
      // Details of a closed lead stay as they were when it closed.
      throw new ValidationError(`This lead is ${lead.status.toLowerCase()} — reopen it before editing`);
    }
    const changes = {};
    for (const field of ['name', 'contactName', 'phone', 'email', 'city', 'state', 'source', 'estimatedValuePaise', 'expectedCloseDate', 'ownerId', 'requirement']) {
      if (input[field] !== undefined) changes[field] = input[field] === '' ? null : input[field];
    }
    await lead.update(changes);
    return this.getView(id);
  }

  /**
   * Moves a lead along the pipeline by hand. QUOTED and WON are not offered:
   * they are set by raising a quotation and by winning the business.
   */
  static async setStatus(id, status, reason) {
    const lead = await this.get(id);
    if (!MANUAL_STATUSES.includes(status)) {
      throw new ValidationError(`"${status}" is set by what happens to the lead — quote it, or convert it to a customer`);
    }
    if (status === 'LOST' && !String(reason || '').trim()) {
      throw new ValidationError('Say why the lead was lost — it is the only way to learn anything from it');
    }
    if (lead.status === 'WON') throw new ValidationError('A won lead cannot be moved back');
    await lead.update({ status, lostReason: status === 'LOST' ? String(reason).trim() : null });
    return this.getView(id);
  }

  /** Called when a quotation is raised against this lead. */
  static async markQuoted(leadId, transaction) {
    const lead = await Lead.findByPk(leadId, { transaction });
    if (!lead) throw new NotFoundError('Lead not found');
    if (OPEN_STATUSES.includes(lead.status) && lead.status !== 'QUOTED') {
      await lead.update({ status: 'QUOTED' }, { transaction });
    }
    return lead;
  }

  /**
   * Turns the lead into a customer. Either links one that already exists or
   * creates one from the lead's own details, and marks the lead won.
   */
  static async convert(id, { customerPartyId } = {}) {
    return sequelize.transaction(async (transaction) => {
      const lead = await Lead.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!lead) throw new NotFoundError('Lead not found');
      if (lead.status === 'WON') throw new ValidationError('This lead has already been won');
      if (lead.status === 'LOST') throw new ValidationError('This lead was lost — reopen it first');

      let party;
      if (customerPartyId) {
        party = await Party.findByPk(customerPartyId, { transaction });
        if (!party || party.partyType !== 'CUSTOMER') throw new NotFoundError('Customer not found');
      } else {
        party = await Party.create(
          {
            partyType: 'CUSTOMER',
            name: lead.name,
            phone: lead.phone || null,
            email: lead.email || null,
            city: lead.city || null,
            state: lead.state || null,
            status: 'active',
          },
          { transaction }
        );
      }

      await lead.update({ status: 'WON', customerPartyId: party.id }, { transaction });
      return { lead: view(await this.get(id, transaction)), customer: party.toJSON() };
    });
  }

  // --- Activities ----------------------------------------------------------

  static async addActivity(leadId, input) {
    await this.get(leadId);
    // A task nobody is due to do never surfaces in the follow-up list.
    if (input.type === 'TASK' && !input.dueDate) throw new ValidationError('A task needs a date it is due by');
    const activity = await LeadActivity.create({
      leadId,
      type: input.type,
      subject: String(input.subject).trim(),
      detail: input.detail || null,
      occurredAt: input.type === 'TASK' ? null : input.occurredAt || new Date(),
      dueDate: input.type === 'TASK' ? input.dueDate || null : null,
      assignedTo: input.assignedTo || null,
      createdBy: getUserId() || null,
    });
    // Any contact at all moves a new lead on: it has now been followed up.
    const lead = await Lead.findByPk(leadId);
    if (lead.status === 'NEW' && input.type !== 'NOTE') await lead.update({ status: 'CONTACTED' });
    return activity.toJSON();
  }

  static async completeActivity(id) {
    const activity = await LeadActivity.findByPk(id);
    if (!activity) throw new NotFoundError('Activity not found');
    if (activity.completedAt) throw new ValidationError('This one is already done');
    await activity.update({ completedAt: new Date() });
    return activity.toJSON();
  }

  /** Tasks still to do, oldest first — the follow-up list a salesperson works from. */
  static async pendingTasks({ assignedTo, dueBefore } = {}) {
    const where = { type: 'TASK', completedAt: null };
    if (assignedTo) where.assignedTo = assignedTo;
    if (dueBefore) where.dueDate = { [Op.lte]: dueBefore };

    const rows = await LeadActivity.findAll({
      where,
      include: [
        { model: Lead, as: 'lead', attributes: ['id', 'leadNumber', 'name', 'status'] },
        { model: User, as: 'assignee', attributes: ['id', 'firstName', 'lastName'] },
      ],
      order: [['dueDate', 'ASC']],
      limit: 200,
    });
    const now = today();
    return rows.map((r) => ({
      ...r.toJSON(),
      isOverdue: !!r.dueDate && String(r.dueDate) < now,
    }));
  }

  /** Counts and value by status — the pipeline at a glance. */
  static async pipeline() {
    const rows = await Lead.findAll({
      attributes: [
        'status',
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('estimatedValuePaise')), 0), 'value'],
      ],
      group: ['status'],
      raw: true,
    });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, { count: Number(r.count), valuePaise: Number(r.value) }]));
    const stages = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'WON', 'LOST'];
    return {
      stages: stages.map((status) => ({ status, ...(byStatus[status] || { count: 0, valuePaise: 0 }) })),
      openCount: OPEN_STATUSES.reduce((sum, s) => sum + (byStatus[s]?.count || 0), 0),
      openValuePaise: OPEN_STATUSES.reduce((sum, s) => sum + (byStatus[s]?.valuePaise || 0), 0),
    };
  }
}

module.exports = { CrmService, OPEN_STATUSES };
