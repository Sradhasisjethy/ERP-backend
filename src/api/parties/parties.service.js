const { Op } = require('sequelize');
const { Party } = require('./party.model');
const { LabourWageProfile } = require('./labourWageProfile.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');

class PartiesService {
  static async listParties(page, limit, { search, status, partyType } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { gstin: { [Op.iLike]: `%${search}%` } }];
    if (status) where.status = status;
    if (partyType) where.partyType = partyType;

    return Party.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: LabourWageProfile, as: 'wageProfile', required: false }],
      order: [['name', 'ASC']],
    });
  }

  static async getParty(id) {
    const party = await Party.findByPk(id, { include: [{ model: LabourWageProfile, as: 'wageProfile', required: false }] });
    if (!party) throw new NotFoundError('Party not found');
    return party;
  }

  static async createParty(data) {
    return Party.create(data);
  }

  static async updateParty(id, data) {
    const party = await this.getParty(id);
    return party.update(data);
  }

  static async deleteParty(id) {
    const party = await this.getParty(id);
    await party.destroy();
    return true;
  }

  // --- Labour wage profile (1:1 extension, only meaningful for partyType=LABOUR) ---
  static async upsertWageProfile(partyId, data) {
    const party = await this.getParty(partyId);
    if (party.partyType !== 'LABOUR') {
      throw new ValidationError('Wage profiles can only be set for LABOUR parties');
    }

    const [profile] = await LabourWageProfile.findOrCreate({
      where: { partyId },
      defaults: { partyId, ...data },
    });
    await profile.update(data);
    return profile;
  }
}

module.exports = { PartiesService };
