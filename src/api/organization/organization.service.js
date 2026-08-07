const { Op } = require('sequelize');
const { Organization } = require('./organization.model');
const { Office } = require('./office.model');
const { Department } = require('./department.model');
const { NotFoundError } = require('../../core/AppError');

class OrganizationService {
  // --- Organizations ---
  static async listOrganizations(page, limit, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    return Organization.findAndCountAll({ where, limit, offset });
  }

  static async getOrganization(id) {
    const org = await Organization.findByPk(id);
    if (!org) throw new NotFoundError('Organization not found');
    return org;
  }

  static async createOrganization(data) {
    return Organization.create(data);
  }

  static async updateOrganization(id, data) {
    const org = await this.getOrganization(id);
    return org.update(data);
  }

  static async deleteOrganization(id) {
    const org = await this.getOrganization(id);
    await org.destroy();
    return true;
  }

  // --- Offices ---
  static async listOffices(page, limit, organizationId, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    return Office.findAndCountAll({ where, limit, offset });
  }

  static async getOffice(id) {
    const office = await Office.findByPk(id);
    if (!office) throw new NotFoundError('Office not found');
    return office;
  }

  static async createOffice(data) {
    return Office.create(data);
  }

  static async updateOffice(id, data) {
    const office = await this.getOffice(id);
    return office.update(data);
  }

  static async deleteOffice(id) {
    const office = await this.getOffice(id);
    await office.destroy();
    return true;
  }

  // --- Departments ---
  static async listDepartments(page, limit, organizationId, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    return Department.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Department, as: 'subDepartments' }],
    });
  }

  static async getDepartment(id) {
    const dept = await Department.findByPk(id, {
      include: [
        { model: Department, as: 'subDepartments' },
        { model: Department, as: 'parentDepartment' },
      ],
    });
    if (!dept) throw new NotFoundError('Department not found');
    return dept;
  }

  static async createDepartment(data) {
    return Department.create(data);
  }

  static async updateDepartment(id, data) {
    const dept = await this.getDepartment(id);
    return dept.update(data);
  }

  static async deleteDepartment(id) {
    const dept = await this.getDepartment(id);
    await dept.destroy();
    return true;
  }
}

module.exports = { OrganizationService };
