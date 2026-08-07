const { User } = require('../users/user.model');
const { Organization } = require('../organization/organization.model');
const { Office } = require('../organization/office.model');
const { Department } = require('../organization/department.model');
const { AdGroup } = require('../roles/role.model');

class DashboardService {
  static async getStats() {
    const [totalEmployees, activeOrgs, departments, offices, roles] = await Promise.all([
      User.count(),
      Organization.count({ where: { status: 'active' } }),
      Department.count(),
      Office.count(),
      AdGroup.count(),
    ]);

    // Get recent employees (last 5)
    const recentEmployees = await User.findAll({
      order: [['createdAt', 'DESC']],
      limit: 5,
      attributes: ['id', 'firstName', 'lastName', 'email', 'createdAt'],
    });

    return {
      totalEmployees,
      activeOrgs,
      departments,
      offices,
      roles,
      recentActivity: recentEmployees.map((emp) => ({
        id: emp.id,
        description: `${emp.firstName} ${emp.lastName} was added`,
        email: emp.email,
        timestamp: emp.createdAt,
      })),
    };
  }
}

module.exports = { DashboardService };
