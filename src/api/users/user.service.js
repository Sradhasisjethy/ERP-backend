const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User } = require('./user.model');
const { NotFoundError } = require('../../core/AppError');

class UserService {
  async list(query) {
    const { page = 1, limit = 20, search, status, employeeType, departmentId, organizationId } = query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (employeeType) where.employeeType = employeeType;
    if (departmentId) where.departmentId = departmentId;
    if (organizationId) where.organizationId = organizationId;

    if (search) {
      where[Op.or] = [
        { firstName: { [Op.iLike]: `%${search}%` } },
        { lastName: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await User.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: User, as: 'hr', attributes: ['id', 'firstName', 'lastName', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    return {
      rows,
      count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    };
  }

  async getById(id) {
    const user = await User.findByPk(id, {
      include: [
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: User, as: 'hr', attributes: ['id', 'firstName', 'lastName', 'email'] },
      ],
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    return user;
  }

  async create(data) {
    const { password, ...rest } = data;
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      ...rest,
      passwordHash,
    });

    const userJson = user.toJSON();
    delete userJson.passwordHash;
    return userJson;
  }

  async update(id, data) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await user.update(data);
    return user;
  }

  async delete(id) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await user.destroy();
    return true;
  }
}

module.exports = { userService: new UserService() };
