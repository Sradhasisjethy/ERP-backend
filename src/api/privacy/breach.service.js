const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { DataBreach } = require('./privacy.model');
const { PrivacyService, today } = require('./privacy.service');
const { BOARD_REPORT_HOURS } = require('./privacy.constants');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');

/**
 * The personal data breach register (s.8(6), Rules r.7).
 *
 * The Act sets no harm threshold: every breach is intimated to the Board and to
 * each affected person. So the register tracks three clocks per breach —
 * intimation to the Board "without delay", the detailed report within 72 hours
 * of becoming aware, and notice to the people affected — and a breach cannot
 * be closed until all three are recorded.
 */

const HOUR = 60 * 60 * 1000;

const view = (breach) => {
  const json = typeof breach.toJSON === 'function' ? breach.toJSON() : breach;
  const due = new Date(json.boardReportDueAt).getTime();
  return {
    ...json,
    hoursToBoardReport: json.boardReportSubmittedAt ? null : Math.round((due - Date.now()) / HOUR),
    boardReportOverdue: !json.boardReportSubmittedAt && due < Date.now(),
  };
};

const nextNumber = async (transaction) => {
  const prefix = `BRH/${today().slice(0, 4)}/`;
  const count = await DataBreach.count({ where: { breachNumber: { [Op.like]: `${prefix}%` } }, transaction });
  return `${prefix}${String(count + 1).padStart(3, '0')}`;
};

class BreachService {
  static async list() {
    const rows = await DataBreach.findAll({ order: [['discoveredAt', 'DESC']] });
    return rows.map(view);
  }

  static async get(id) {
    const breach = await DataBreach.findByPk(id);
    if (!breach) throw new NotFoundError('Breach not found');
    return breach;
  }

  static async getView(id) {
    return view(await this.get(id));
  }

  static async create(input) {
    const discoveredAt = new Date(input.discoveredAt);
    if (discoveredAt.getTime() > Date.now() + 5 * 60 * 1000) throw new ValidationError('A breach cannot be discovered in the future');
    return sequelize.transaction(async (transaction) => {
      const breach = await DataBreach.create(
        {
          ...input,
          breachNumber: await nextNumber(transaction),
          status: 'OPEN',
          discoveredAt,
          // The clock runs from when the business became aware, not from when
          // someone got round to logging it.
          boardReportDueAt: new Date(discoveredAt.getTime() + BOARD_REPORT_HOURS * HOUR),
          reportedBy: getUserId() || null,
        },
        { transaction }
      );
      return view(breach);
    });
  }

  static async update(id, input) {
    const breach = await this.get(id);
    if (breach.status === 'CLOSED') throw new ValidationError('A closed breach cannot be changed');
    const values = { ...input };
    if (values.discoveredAt) {
      values.boardReportDueAt = new Date(new Date(values.discoveredAt).getTime() + BOARD_REPORT_HOURS * HOUR);
    }
    if (values.containedAt && breach.status === 'OPEN') values.status = 'CONTAINED';
    await breach.update(values);
    return view(breach);
  }

  /** Records one of the three notifications. `at` defaults to now. */
  static async recordStep(id, step, { at, reference, method } = {}) {
    const breach = await this.get(id);
    if (breach.status === 'CLOSED') throw new ValidationError('A closed breach cannot be changed');
    const when = at ? new Date(at) : new Date();
    const values = {
      BOARD_INTIMATED: { boardIntimatedAt: when },
      BOARD_REPORT_SUBMITTED: { boardReportSubmittedAt: when, boardIntimatedAt: breach.boardIntimatedAt || when, boardReference: reference || breach.boardReference },
      PRINCIPALS_NOTIFIED: { principalsNotifiedAt: when, notificationMethod: method || breach.notificationMethod },
      CONTAINED: { containedAt: when, status: 'CONTAINED' },
    }[step];
    if (!values) throw new ValidationError('Unknown step');
    await breach.update(values);
    return view(breach);
  }

  static async close(id) {
    const breach = await this.get(id);
    const missing = [];
    if (!breach.boardIntimatedAt) missing.push('intimation to the Board');
    if (!breach.boardReportSubmittedAt) missing.push('the detailed report to the Board');
    if (!breach.principalsNotifiedAt) missing.push('notice to the people affected');
    if (!breach.containedAt) missing.push('containment');
    if (missing.length) throw new ValidationError(`Record ${missing.join(', ')} before closing (DPDP Rules r.7)`);
    await breach.update({ status: 'CLOSED', closedAt: new Date() });
    return view(breach);
  }

  /**
   * The two texts Rule 7 asks for, assembled from the register: the report to
   * the Board (r.7(2)) and the notice to each affected person (r.7(1)). They
   * are drafts for a person to check and send — the system does not send them.
   */
  static async report(id) {
    const breach = await this.get(id);
    const profile = await PrivacyService.getProfile();
    const contact = profile && profile.contactEmail
      ? `${profile.contactName || 'Privacy contact'}${profile.contactDesignation ? `, ${profile.contactDesignation}` : ''} — ${profile.contactEmail}${profile.contactPhone ? `, ${profile.contactPhone}` : ''}`
      : '[name the privacy contact in Privacy > Settings]';
    const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not yet');
    const list = (items) => (items && items.length ? items.join(', ') : 'to be determined');

    const boardReport = [
      `Personal data breach report — ${breach.breachNumber}`,
      '',
      `1. Description of the breach: ${breach.description}`,
      `2. Nature and extent: categories of personal data ${list(breach.dataCategories)}; people affected ${list(breach.principalCategories)}${breach.affectedCount ? ` (about ${breach.affectedCount})` : ''}.`,
      `3. Timing: occurred ${fmt(breach.occurredAt)}; became aware ${fmt(breach.discoveredAt)}; contained ${fmt(breach.containedAt)}.`,
      `4. Facts, circumstances and reasons: ${breach.cause || 'under investigation'}`,
      `5. Likely impact: ${breach.likelyConsequences || 'under assessment'}`,
      `6. Measures to mitigate the risk and prevent recurrence: ${breach.mitigation || 'to be described'}`,
      `7. Intimations to affected Data Principals: ${breach.principalsNotifiedAt ? `sent ${fmt(breach.principalsNotifiedAt)} by ${breach.notificationMethod || 'the means recorded'}` : 'not yet sent'}`,
      `8. Contact: ${contact}`,
    ].join('\n');

    const principalNotice = [
      'Notice of a personal data breach',
      '',
      `What happened: ${breach.description}`,
      `When: we became aware on ${fmt(breach.discoveredAt)}.`,
      `Your data involved: ${list(breach.dataCategories)}.`,
      `What it may mean for you: ${breach.likelyConsequences || 'we are still assessing this.'}`,
      `What we have done: ${breach.mitigation || 'we are taking steps to contain it.'}`,
      `What you can do: ${breach.safetyMeasures || 'watch for unexpected calls or messages asking for passwords, OTPs or bank details.'}`,
      `Who to contact: ${contact}`,
    ].join('\n');

    return { breach: view(breach), boardReport, principalNotice };
  }
}

module.exports = { BreachService };
