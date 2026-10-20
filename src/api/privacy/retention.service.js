const { Op } = require('sequelize');
const { RetentionRule } = require('./privacy.model');
const { RETENTION_CATEGORIES } = require('./privacy.constants');
const { ErasureService, INACTIVE_STATUSES } = require('./erasure.service');
const { Lead } = require('../crm/lead.model');
const { Party } = require('../parties/party.model');
const { User } = require('../users/user.model');
const { ValidationError, NotFoundError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { logger } = require('../../utils/logger');
const { asTenant } = require('../../core/platformOwner');
const { Tenant } = require('../organization/tenant.model');

/**
 * The retention schedule (s.8(7), Rules r.8): once the purpose a record was
 * collected for is spent and the law no longer needs it, its personal fields
 * are erased.
 *
 * Every rule starts switched off. Erasure cannot be undone, and the defaults
 * are a starting point an owner should check against their own legal advice;
 * a deploy must never be what decides to wipe a former employee's address.
 *
 * One schedule for the whole platform, set by the application owner and
 * applied to every organisation. Finding what is due reads across all of them
 * (the desk has no organisation in context); each erasure then runs as the
 * organisation that holds the record, so its audit trail records it.
 */

const BATCH = 200;
const DAY = 24 * 60 * 60 * 1000;

const OPEN_LEAD = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED'];

/** For each category: the records past their period, and how to erase one. */
const FINDERS = {
  LOST_LEADS: { type: 'LEAD', model: Lead, where: (cutoff) => ({ status: 'LOST', erasedAt: null, updatedAt: { [Op.lt]: cutoff } }) },
  DORMANT_LEADS: {
    type: 'LEAD',
    model: Lead,
    where: (cutoff) => ({ status: { [Op.in]: OPEN_LEAD }, customerPartyId: null, erasedAt: null, updatedAt: { [Op.lt]: cutoff } }),
  },
  INACTIVE_LABOUR: {
    type: 'PARTY',
    model: Party,
    where: (cutoff) => ({ partyType: 'LABOUR', status: 'inactive', erasedAt: null, updatedAt: { [Op.lt]: cutoff } }),
  },
  INACTIVE_INDIVIDUAL_CUSTOMERS: {
    type: 'PARTY',
    model: Party,
    where: (cutoff) => ({
      partyType: 'CUSTOMER',
      status: 'inactive',
      erasedAt: null,
      updatedAt: { [Op.lt]: cutoff },
      [Op.or]: [{ gstin: null }, { gstin: '' }],
    }),
  },
  FORMER_EMPLOYEES: {
    type: 'USER',
    model: User,
    where: (cutoff) => ({
      status: { [Op.in]: INACTIVE_STATUSES },
      isSystem: { [Op.not]: true },
      erasedAt: null,
      updatedAt: { [Op.lt]: cutoff },
      [Op.or]: [{ resignationDate: null }, { resignationDate: { [Op.lt]: cutoff.toISOString().slice(0, 10) } }],
    }),
  },
};

class RetentionService {
  /** Every category has a row, so the screen always shows the whole schedule. */
  static async ensureRules() {
    const existing = await RetentionRule.findAll();
    const have = new Set(existing.map((r) => r.category));
    for (const [category, def] of Object.entries(RETENTION_CATEGORIES)) {
      if (!have.has(category)) {
        existing.push(await RetentionRule.create({ category, retentionDays: def.defaultDays, enabled: false }));
      }
    }
    return existing;
  }

  static async list() {
    const rules = await this.ensureRules();
    const out = [];
    for (const category of Object.keys(RETENTION_CATEGORIES)) {
      const rule = rules.find((r) => r.category === category);
      out.push({ ...rule.toJSON(), ...RETENTION_CATEGORIES[category], dueCount: await this.dueCount(rule) });
    }
    return out;
  }

  static cutoff(rule) {
    return new Date(Date.now() - rule.retentionDays * DAY);
  }

  static async dueCount(rule) {
    const finder = FINDERS[rule.category];
    if (!finder) return null; // AUDIT_LOG_SNAPSHOTS: counted when it runs
    return finder.model.count({ where: finder.where(this.cutoff(rule)) });
  }

  static async update(id, { retentionDays, enabled }) {
    const rule = await RetentionRule.findByPk(id);
    if (!rule) throw new NotFoundError('Retention rule not found');
    const def = RETENTION_CATEGORIES[rule.category];
    if (retentionDays !== undefined && retentionDays < def.minDays) {
      throw new ValidationError(`${def.label}: keep for at least ${def.minDays} days`);
    }
    await rule.update({
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      updatedBy: getUserId() || null,
    });
    return rule;
  }

  /**
   * Applies one rule. Each record is erased in its own transaction, so one
   * failure (a user who cannot be erased, say) is logged and skipped rather
   * than stopping the rest.
   */
  static async apply(rule) {
    const cutoff = this.cutoff(rule);
    let erased = 0;
    const failures = [];

    if (rule.category === 'AUDIT_LOG_SNAPSHOTS') {
      for (const tenant of await Tenant.findAll({ attributes: ['id'] })) {
        erased += await asTenant(tenant.id, () => ErasureService.maskOldAuditSnapshots(cutoff));
      }
    } else {
      const finder = FINDERS[rule.category];
      // unscoped: the default scopes hide tenantId, which each erasure needs.
      const due = await finder.model.unscoped().findAll({ where: finder.where(cutoff), attributes: ['id', 'tenantId'], limit: BATCH });
      for (const row of due) {
        try {
          await asTenant(row.tenantId, () => ErasureService.erase(finder.type, row.id, { reason: `Retention schedule: ${rule.category}` }));
          erased += 1;
        } catch (error) {
          failures.push({ id: row.id, error: error.message });
          logger.warn({ message: 'Retention erasure skipped a record', category: rule.category, error: error.message });
        }
      }
    }
    await rule.update({ lastRunAt: new Date(), lastRunCount: erased });
    return { category: rule.category, erased, failures: failures.length };
  }

  static async run(id) {
    const rule = await RetentionRule.findByPk(id);
    if (!rule) throw new NotFoundError('Retention rule not found');
    if (!rule.enabled) throw new ValidationError('Switch this rule on before running it');
    return this.apply(rule);
  }

  /** Nightly, once for the whole platform: every enabled rule. */
  static async applyEnabled() {
    const rules = await RetentionRule.findAll({ where: { enabled: true } });
    const results = [];
    for (const rule of rules) results.push(await this.apply(rule));
    return results;
  }
}

module.exports = { RetentionService };
