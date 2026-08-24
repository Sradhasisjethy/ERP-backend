const { Op } = require('sequelize');
const { Uom } = require('./uom.model');
const { ProductCategory } = require('./productCategory.model');
const { HsnCode } = require('./hsnCode.model');
const { Product } = require('./product.model');
const { MixDesign } = require('./mixDesign.model');
const { MixDesignLine } = require('./mixDesignLine.model');
const { UomConversion } = require('./uomConversion.model');
const { toOrder } = require('../../utils/pagination');
const { assertNoDependents, assertUnique } = require('../../core/masterGuards');
const { NotFoundError, ValidationError } = require('../../core/AppError');

/**
 * Dependency maps used to refuse a delete that would orphan or destroy
 * history. Required lazily: products.service is loaded while the model graph
 * is still being wired, and importing sales/purchasing models at the top would
 * close a require cycle.
 */
const productDependencies = () => {
  const {
    SalesOrderLine, SalesInvoiceLine, SalesReturnLine, PurchaseOrderLine, GoodsReceiptLine, PurchaseReturnLine,
    StockLedgerEntry, StockLot, StockTransferLine, ProductionEntry, ProductionPlanLine, MaterialConsumption,
    WastageRecord, DeliveryChallanLine, PriceListItem, ContractorMaterialIssueLine, ContractorProductionEntry,
    PurchaseIndentLine, StockReservation,
  } = require('../../models');

  return [
    { model: SalesOrderLine, column: 'productId', label: 'sales order line' },
    { model: SalesInvoiceLine, column: 'productId', label: 'sales invoice line' },
    { model: SalesReturnLine, column: 'productId', label: 'sales return line' },
    { model: DeliveryChallanLine, column: 'productId', label: 'delivery challan line' },
    { model: PurchaseOrderLine, column: 'productId', label: 'purchase order line' },
    { model: GoodsReceiptLine, column: 'productId', label: 'goods receipt line' },
    { model: PurchaseReturnLine, column: 'productId', label: 'purchase return line' },
    { model: PurchaseIndentLine, column: 'productId', label: 'purchase indent line' },
    { model: StockLedgerEntry, column: 'productId', label: 'stock movement' },
    { model: StockLot, column: 'productId', label: 'stock lot' },
    { model: StockReservation, column: 'productId', label: 'stock reservation' },
    { model: StockTransferLine, column: 'productId', label: 'stock transfer line' },
    { model: ProductionEntry, column: 'productId', label: 'production entry' },
    { model: ProductionPlanLine, column: 'productId', label: 'production plan line' },
    { model: MaterialConsumption, column: 'rawMaterialProductId', label: 'material consumption' },
    { model: WastageRecord, column: 'productId', label: 'wastage record' },
    { model: ContractorMaterialIssueLine, column: 'productId', label: 'contractor material issue' },
    { model: ContractorProductionEntry, column: 'productId', label: 'contractor production entry' },
    // These two are the reason an application-level guard is needed at all:
    // both foreign keys were declared ON DELETE CASCADE, so a product that had
    // never been transacted took its whole BOM history and price rows with it.
    { model: MixDesign, column: 'productId', label: 'bill of materials (mix design)' },
    { model: MixDesignLine, column: 'rawMaterialProductId', label: 'bill of materials component line' },
    { model: PriceListItem, column: 'productId', label: 'price list entry' },
  ];
};

/** Columns a client may sort each master list by. Anything else falls back. */
const SORTABLE = {
  uom: ['name', 'code', 'status', 'createdAt'],
  category: ['name', 'code', 'status', 'createdAt'],
  hsn: ['code', 'gstRatePercent', 'status', 'createdAt'],
  product: ['name', 'code', 'productType', 'status', 'reorderLevel', 'standardCostPaise', 'createdAt'],
};

class ProductsService {
  // --- UoM ---
  static async listUoms(page, limit, search, status, { sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { code: { [Op.iLike]: `%${search}%` } }];
    if (status) where.status = status;
    return Uom.findAndCountAll({ where, limit, offset, order: toOrder(sortBy, sortDir, SORTABLE.uom, [['name', 'ASC']]) });
  }

  static async getUom(id) {
    const uom = await Uom.findByPk(id);
    if (!uom) throw new NotFoundError('UoM not found');
    return uom;
  }

  static async createUom(data) {
    await assertUnique(Uom, { code: data.code }, null, `A unit of measure with code "${data.code}" already exists`);
    return Uom.create(data);
  }

  static async updateUom(id, data) {
    const uom = await this.getUom(id);
    if (data.code && data.code !== uom.code) {
      await assertUnique(Uom, { code: data.code }, id, `A unit of measure with code "${data.code}" already exists`);
    }
    return uom.update(data);
  }

  static async deleteUom(id) {
    const uom = await this.getUom(id);
    await assertNoDependents(
      [
        { model: Product, column: 'uomId', label: 'product' },
        { model: MixDesignLine, column: 'uomId', label: 'bill of materials component line' },
        { model: UomConversion, column: 'fromUomId', label: 'unit conversion' },
        { model: UomConversion, column: 'toUomId', label: 'unit conversion' },
      ],
      id,
      'unit of measure'
    );
    await uom.destroy();
    return true;
  }

  // --- Product Category ---
  static async listProductCategories(page, limit, search, status, { sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { code: { [Op.iLike]: `%${search}%` } }];
    if (status) where.status = status;
    return ProductCategory.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: ProductCategory, as: 'subCategories' }],
      order: toOrder(sortBy, sortDir, SORTABLE.category, [['name', 'ASC']]),
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

  /**
   * A category tree that loops has no root, so every consumer that walks it
   * upward (ageing-threshold inheritance in inventory/ageing.service.js, the
   * category filter on reports) would spin forever.
   */
  static async assertNoCategoryCycle(categoryId, parentId) {
    if (!parentId) return;
    if (parentId === categoryId) throw new ValidationError('A category cannot be its own parent');

    const seen = new Set([categoryId]);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ValidationError('That parent would create a circular category tree');
      }
      seen.add(cursor);
      const parent = await ProductCategory.findByPk(cursor, { attributes: ['id', 'parentId'] });
      if (!parent) throw new ValidationError('The selected parent category does not exist');
      cursor = parent.parentId;
    }
  }

  static async createProductCategory(data) {
    if (data.code) {
      await assertUnique(ProductCategory, { code: data.code }, null, `A product category with code "${data.code}" already exists`);
    }
    if (data.parentId) await this.assertNoCategoryCycle(null, data.parentId);
    return ProductCategory.create(data);
  }

  static async updateProductCategory(id, data) {
    const category = await this.getProductCategory(id);
    if (data.code && data.code !== category.code) {
      await assertUnique(ProductCategory, { code: data.code }, id, `A product category with code "${data.code}" already exists`);
    }
    if (data.parentId !== undefined) await this.assertNoCategoryCycle(id, data.parentId);
    return category.update(data);
  }

  static async deleteProductCategory(id) {
    const category = await this.getProductCategory(id);
    await assertNoDependents(
      [
        { model: Product, column: 'categoryId', label: 'product' },
        { model: ProductCategory, column: 'parentId', label: 'sub-category' },
      ],
      id,
      'product category'
    );
    await category.destroy();
    return true;
  }

  // --- HSN Code ---
  static async listHsnCodes(page, limit, search, status, { sortBy, sortDir } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where[Op.or] = [{ code: { [Op.iLike]: `%${search}%` } }, { description: { [Op.iLike]: `%${search}%` } }];
    if (status) where.status = status;
    return HsnCode.findAndCountAll({ where, limit, offset, order: toOrder(sortBy, sortDir, SORTABLE.hsn, [['code', 'ASC']]) });
  }

  static async getHsnCode(id) {
    const hsn = await HsnCode.findByPk(id);
    if (!hsn) throw new NotFoundError('HSN code not found');
    return hsn;
  }

  static async createHsnCode(data) {
    await assertUnique(HsnCode, { code: data.code }, null, `HSN code "${data.code}" already exists`);
    return HsnCode.create(data);
  }

  static async updateHsnCode(id, data) {
    const hsn = await this.getHsnCode(id);
    if (data.code && data.code !== hsn.code) {
      await assertUnique(HsnCode, { code: data.code }, id, `HSN code "${data.code}" already exists`);
    }
    return hsn.update(data);
  }

  static async deleteHsnCode(id) {
    const hsn = await this.getHsnCode(id);
    await assertNoDependents([{ model: Product, column: 'hsnId', label: 'product' }], id, 'HSN code');
    await hsn.destroy();
    return true;
  }

  // --- Product ---
  static async listProducts(page, limit, { search, status, categoryId, productType, sortBy, sortDir } = {}) {
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
      order: toOrder(sortBy, sortDir, SORTABLE.product, [['name', 'ASC']]),
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

  /**
   * The referenced masters must exist *within this tenant*. Sequelize's CLS
   * tenant scope makes a foreign id from another tenant simply not resolve, so
   * this doubles as the cross-tenant check — without it the raw foreign key
   * would happily accept another tenant's UoM.
   */
  static async assertReferencesResolve({ uomId, categoryId, hsnId }) {
    if (uomId && !(await Uom.count({ where: { id: uomId } }))) {
      throw new ValidationError('The selected unit of measure does not exist');
    }
    if (categoryId && !(await ProductCategory.count({ where: { id: categoryId } }))) {
      throw new ValidationError('The selected product category does not exist');
    }
    if (hsnId && !(await HsnCode.count({ where: { id: hsnId } }))) {
      throw new ValidationError('The selected HSN code does not exist');
    }
  }

  static async createProduct(data) {
    await assertUnique(Product, { code: data.code }, null, `A product with code "${data.code}" already exists`);
    await this.assertReferencesResolve(data);
    return Product.create(data);
  }

  static async updateProduct(id, data) {
    const product = await this.getProduct(id);
    if (data.code && data.code !== product.code) {
      await assertUnique(Product, { code: data.code }, id, `A product with code "${data.code}" already exists`);
    }
    await this.assertReferencesResolve(data);

    // min/max are individually optional, so the pair has to be validated
    // against whatever the record will hold *after* the patch, not just
    // against what the request happens to carry.
    const min = data.minStock !== undefined ? data.minStock : product.minStock;
    const max = data.maxStock !== undefined ? data.maxStock : product.maxStock;
    if (min !== null && max !== null && min !== undefined && max !== undefined && Number(max) < Number(min)) {
      throw new ValidationError('Maximum stock cannot be lower than minimum stock');
    }

    return product.update(data);
  }

  static async deleteProduct(id) {
    const product = await this.getProduct(id);
    await assertNoDependents(productDependencies(), id, 'product');
    await product.destroy();
    return true;
  }
}

module.exports = { ProductsService };
