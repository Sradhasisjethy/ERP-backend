const { Op } = require('sequelize');
const { Organization } = require('./organization.model');
const { Office } = require('./office.model');
const { Department } = require('./department.model');
const { OfficeDepartment } = require('./officeDepartment.model');
const { getTenantId } = require('../../core/tenantContext');
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

    return Office.findAndCountAll({
      where,
      limit,
      offset,
      distinct: true,
      include: [
        { model: Organization, attributes: ['id', 'name', 'code'] },
        {
          model: Department,
          as: 'departments',
          attributes: ['id', 'name', 'code'],
          through: { attributes: [] },
        },
      ],
    });
  }

  static async getOffice(id) {
    const office = await Office.findByPk(id, {
      include: [
        { model: Organization, attributes: ['id', 'name', 'code'] },
        {
          model: Department,
          as: 'departments',
          attributes: ['id', 'name', 'code'],
          through: { attributes: [] },
        },
      ],
    });
    if (!office) throw new NotFoundError('Office not found');
    return office;
  }

  static async createOffice(data) {
    const { departmentIds, ...officeData } = data;
    const tenantId = officeData.tenantId || getTenantId() || (officeData.organizationId ? (await Organization.findByPk(officeData.organizationId, { attributes: ['tenantId'] }))?.get('tenantId') : null);
    const office = await Office.create({ ...officeData, ...(tenantId ? { tenantId } : {}) });
    const finalTenantId = office.tenantId || office.get('tenantId') || tenantId;

    if (Array.isArray(departmentIds) && departmentIds.length > 0) {
      const rows = departmentIds.map((deptId) => ({
        tenantId: finalTenantId,
        officeId: office.id,
        departmentId: deptId,
      }));
      await OfficeDepartment.bulkCreate(rows, { ignoreDuplicates: true });
    }

    return this.getOffice(office.id);
  }

  static async updateOffice(id, data) {
    const { departmentIds, ...officeData } = data;
    const office = await this.getOffice(id);
    await office.update(officeData);
    const tenantId = office.tenantId || office.get('tenantId') || getTenantId();

    if (Array.isArray(departmentIds)) {
      await OfficeDepartment.destroy({ where: { officeId: office.id } });
      if (departmentIds.length > 0) {
        const rows = departmentIds.map((deptId) => ({
          tenantId,
          officeId: office.id,
          departmentId: deptId,
        }));
        await OfficeDepartment.bulkCreate(rows, { ignoreDuplicates: true });
      }
    }

    return this.getOffice(office.id);
  }

  static async deleteOffice(id) {
    const office = await this.getOffice(id);
    await OfficeDepartment.destroy({ where: { officeId: office.id } });
    await office.destroy();
    return true;
  }

  // --- Departments ---
  static async listDepartments(page, limit, organizationId, officeId, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (organizationId) where.organizationId = organizationId;
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    const include = [
      { model: Organization, attributes: ['id', 'name', 'code'] },
      { model: Office, attributes: ['id', 'name', 'city', 'country'] },
      {
        model: Office,
        as: 'offices',
        attributes: ['id', 'name', 'code', 'city', 'country'],
        through: { attributes: [] },
        ...(officeId ? { where: { id: officeId }, required: true } : {}),
      },
      { model: Department, as: 'subDepartments' },
      { model: Department, as: 'parentDepartment', attributes: ['id', 'name', 'code'] },
    ];

    return Department.findAndCountAll({
      where,
      limit,
      offset,
      distinct: true,
      include,
    });
  }

  static async getDepartment(id) {
    const dept = await Department.findByPk(id, {
      include: [
        { model: Organization, attributes: ['id', 'name', 'code'] },
        { model: Office, attributes: ['id', 'name', 'city', 'country'] },
        {
          model: Office,
          as: 'offices',
          attributes: ['id', 'name', 'code', 'city', 'country'],
          through: { attributes: [] },
        },
        { model: Department, as: 'subDepartments' },
        { model: Department, as: 'parentDepartment' },
      ],
    });
    if (!dept) throw new NotFoundError('Department not found');
    return dept;
  }

  static async createDepartment(data) {
    const { officeIds, ...deptData } = data;
    const tenantId = deptData.tenantId || getTenantId() || (deptData.organizationId ? (await Organization.findByPk(deptData.organizationId, { attributes: ['tenantId'] }))?.get('tenantId') : null);
    const dept = await Department.create({ ...deptData, ...(tenantId ? { tenantId } : {}) });
    const finalTenantId = dept.tenantId || dept.get('tenantId') || tenantId;

    const targetOfficeIds = Array.isArray(officeIds) ? [...officeIds] : [];
    if (dept.officeId && !targetOfficeIds.includes(dept.officeId)) {
      targetOfficeIds.push(dept.officeId);
    }

    if (targetOfficeIds.length > 0) {
      const rows = targetOfficeIds.map((offId) => ({
        tenantId: finalTenantId,
        officeId: offId,
        departmentId: dept.id,
      }));
      await OfficeDepartment.bulkCreate(rows, { ignoreDuplicates: true });
    }

    return this.getDepartment(dept.id);
  }

  static async updateDepartment(id, data) {
    const { officeIds, ...deptData } = data;
    const dept = await this.getDepartment(id);
    await dept.update(deptData);
    const tenantId = dept.tenantId || dept.get('tenantId') || getTenantId();

    if (Array.isArray(officeIds)) {
      await OfficeDepartment.destroy({ where: { departmentId: dept.id } });
      const targetOfficeIds = [...officeIds];
      if (dept.officeId && !targetOfficeIds.includes(dept.officeId)) {
        targetOfficeIds.push(dept.officeId);
      }
      if (targetOfficeIds.length > 0) {
        const rows = targetOfficeIds.map((offId) => ({
          tenantId,
          officeId: offId,
          departmentId: dept.id,
        }));
        await OfficeDepartment.bulkCreate(rows, { ignoreDuplicates: true });
      }
    }

    return this.getDepartment(dept.id);
  }

  static async deleteDepartment(id) {
    const dept = await this.getDepartment(id);
    await OfficeDepartment.destroy({ where: { departmentId: dept.id } });
    await dept.destroy();
    return true;
  }
}

module.exports = { OrganizationService };

