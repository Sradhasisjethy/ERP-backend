const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Uom } = require('./uom.model');
const { ProductCategory } = require('./productCategory.model');
const { HsnCode } = require('./hsnCode.model');
const { Product } = require('./product.model');
const { MixDesign } = require('./mixDesign.model');
const { MixDesignLine } = require('./mixDesignLine.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');

class ProductsService {
  // --- UoM ---
  static async listUoms(page, limit, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;
    return Uom.findAndCountAll({ where, limit, offset, order: [['name', 'ASC']] });
  }

  static async getUom(id) {
    const uom = await Uom.findByPk(id);
    if (!uom) throw new NotFoundError('UoM not found');
    return uom;
  }

  static async createUom(data) {
    return Uom.create(data);
  }

  static async updateUom(id, data) {
    const uom = await this.getUom(id);
    return uom.update(data);
  }

  static async deleteUom(id) {
    const uom = await this.getUom(id);
    await uom.destroy();
    return true;
  }

  // --- Product Category ---
  static async listProductCategories(page, limit, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;
    return ProductCategory.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: ProductCategory, as: 'subCategories' }],
      order: [['name', 'ASC']],
    });
  }

  static async getProductCategory(id) {
    const category = await ProductCategory.findByPk(id, {
      include: [
        { model: ProductCategory, as: 'subCategories' },
        { model: ProductCategory, as: 'parentCategory' },
      ],
    });
    if (!category) throw new NotFoundError('Product category not found');
    return category;
  }

  static async createProductCategory(data) {
    return ProductCategory.create(data);
  }

  static async updateProductCategory(id, data) {
    const category = await this.getProductCategory(id);
    return category.update(data);
  }

  static async deleteProductCategory(id) {
    const category = await this.getProductCategory(id);
    await category.destroy();
    return true;
  }

  // --- HSN Code ---
  static async listHsnCodes(page, limit, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.code = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;
    return HsnCode.findAndCountAll({ where, limit, offset, order: [['code', 'ASC']] });
  }

  static async getHsnCode(id) {
    const hsn = await HsnCode.findByPk(id);
    if (!hsn) throw new NotFoundError('HSN code not found');
    return hsn;
  }

  static async createHsnCode(data) {
    return HsnCode.create(data);
  }

  static async updateHsnCode(id, data) {
    const hsn = await this.getHsnCode(id);
    return hsn.update(data);
  }

  static async deleteHsnCode(id) {
    const hsn = await this.getHsnCode(id);
    await hsn.destroy();
    return true;
  }

  // --- Product ---
  static async listProducts(page, limit, { search, status, categoryId, productType } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { code: { [Op.iLike]: `%${search}%` } }];
    if (status) where.status = status;
    if (categoryId) where.categoryId = categoryId;
    if (productType) where.productType = productType;

    return Product.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: ProductCategory, as: 'category' },
        { model: Uom, as: 'uom' },
        { model: HsnCode, as: 'hsnCode' },
      ],
      order: [['name', 'ASC']],
    });
  }

  static async getProduct(id) {
    const product = await Product.findByPk(id, {
      include: [
        { model: ProductCategory, as: 'category' },
        { model: Uom, as: 'uom' },
        { model: HsnCode, as: 'hsnCode' },
      ],
    });
    if (!product) throw new NotFoundError('Product not found');
    return product;
  }

  static async createProduct(data) {
    return Product.create(data);
  }

  static async updateProduct(id, data) {
    const product = await this.getProduct(id);
    return product.update(data);
  }

  static async deleteProduct(id) {
    const product = await this.getProduct(id);
    await product.destroy();
    return true;
  }

  // --- Mix Design (BOM) ---
  static async listMixDesigns(page, limit, { productId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (productId) where.productId = productId;
    if (search) where.name = { [Op.iLike]: `%${search}%` };

    return MixDesign.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: MixDesignLine, as: 'lines', include: [{ model: Product, as: 'rawMaterial' }] }],
      order: [['createdAt', 'DESC']],
    });
  }

  static async getMixDesign(id) {
    const mixDesign = await MixDesign.findByPk(id, {
      include: [{ model: MixDesignLine, as: 'lines', include: [{ model: Product, as: 'rawMaterial' }] }],
    });
    if (!mixDesign) throw new NotFoundError('Mix design not found');
    return mixDesign;
  }

  // BR-06: production must consume raw materials "per the active mix design
  // for that product" — so creating a new active design deactivates any
  // sibling for the same product inside the same transaction the create runs
  // in, keeping "at most one active design per product" true at every commit.
  static async createMixDesign({ lines, ...data }) {
    if (!lines || !lines.length) {
      throw new ValidationError('A mix design requires at least one line');
    }

    return sequelize.transaction(async (transaction) => {
      await MixDesign.update(
        { isActive: false },
        { where: { productId: data.productId, isActive: true }, transaction }
      );

      const mixDesign = await MixDesign.create({ ...data, isActive: true }, { transaction });
      await MixDesignLine.bulkCreate(
        lines.map((line) => ({ ...line, mixDesignId: mixDesign.id })),
        { transaction, individualHooks: true, validate: true }
      );

      return this.getMixDesign(mixDesign.id);
    });
  }

  static async updateMixDesign(id, { lines, ...data }) {
    const mixDesign = await this.getMixDesign(id);

    return sequelize.transaction(async (transaction) => {
      await mixDesign.update(data, { transaction });

      if (lines) {
        await MixDesignLine.destroy({ where: { mixDesignId: id }, transaction });
        await MixDesignLine.bulkCreate(
          lines.map((line) => ({ ...line, mixDesignId: id })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      return this.getMixDesign(id);
    });
  }

  static async activateMixDesign(id) {
    const mixDesign = await this.getMixDesign(id);

    return sequelize.transaction(async (transaction) => {
      await MixDesign.update(
        { isActive: false },
        { where: { productId: mixDesign.productId, isActive: true }, transaction }
      );
      await mixDesign.update({ isActive: true }, { transaction });
      return this.getMixDesign(id);
    });
  }

  static async deleteMixDesign(id) {
    const mixDesign = await this.getMixDesign(id);
    await mixDesign.destroy();
    return true;
  }
}

module.exports = { ProductsService };
