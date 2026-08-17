const { Op } = require('sequelize');
const { Factory } = require('./factory.model');
const { FinancialYear } = require('./financialYear.model');
const { UserFactory } = require('./userFactory.model');
const { NotFoundError, ConflictError } = require('../../core/AppError');

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
    return FinancialYear.create(data);
  }

  static async setCurrentFinancialYear(id) {
    const fy = await FinancialYear.findByPk(id);
    if (!fy) throw new NotFoundError('Financial year not found');

    await FinancialYear.sequelize.transaction(async (transaction) => {
      await FinancialYear.update({ isCurrent: false }, { where: { isCurrent: true }, transaction });
      await fy.update({ isCurrent: true }, { transaction });
    });

    return fy.reload();
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
