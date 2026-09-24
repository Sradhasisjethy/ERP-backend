const { Op } = require('sequelize');
const { Product } = require('../../products/product.model');
const { ProductCategory } = require('../../products/productCategory.model');
const { Uom } = require('../../products/uom.model');
const { HsnCode } = require('../../products/hsnCode.model');
const { ProductsService } = require('../../products/products.service');

/**
 * The Products family: products themselves and the three masters they point at.
 *
 * Every one of them upserts on its `code`, which is the only field with a
 * unique index behind it. Names are deliberately never used to match — two
 * plants calling the same thing "Pipe 600" and "600mm Pipe" is normal, and a
 * name match would merge them.
 */

const STATUS = {
  header: 'Status',
  field: 'status',
  type: 'enum',
  values: ['Active', 'Inactive'],
  enumMap: { Active: 'active', Inactive: 'inactive' },
  example: 'Active',
  note: 'blank keeps the current status; new records default to Active',
};

const ID_NOTE = 'Filled in by Export. Leave blank for a new record.';

const search = (query, columns) =>
  query.search ? { [Op.or]: columns.map((column) => ({ [column]: { [Op.iLike]: `%${query.search}%` } })) } : {};

const products = {
  key: 'products',
  label: 'Products',
  fileBase: 'Products',
  resource: 'PRODUCT',
  businessKey: 'code',
  businessKeyHeader: 'Product Code',
  dependsOn: 'Import Units of Measure, HSN Codes and Product Categories before Products — a product row is rejected if the code it names does not exist yet.',
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: ID_NOTE },
    { header: 'Product Code', field: 'code', type: 'code', required: true, maxLength: 50, example: 'FG-PIPE-600', note: 'unique; used to match an existing product' },
    { header: 'Product Name', field: 'name', type: 'text', required: true, maxLength: 255, example: 'RCC Pipe 600mm NP2' },
    {
      header: 'Product Type', field: 'productType', type: 'enum', required: true,
      values: ['Finished Good', 'Raw Material'],
      enumMap: { 'Finished Good': 'FINISHED_GOOD', 'Raw Material': 'RAW_MATERIAL' },
      example: 'Finished Good',
    },
    {
      header: 'Unit Code', field: 'uomId', type: 'reference', required: true,
      reference: { master: 'uoms', label: 'the Units of Measure master' },
      exportValue: (record) => record.uom?.code || null,
      example: 'NOS',
    },
    {
      header: 'Category Code', field: 'categoryId', type: 'reference',
      reference: { master: 'productCategories', label: 'the Product Categories master' },
      exportValue: (record) => record.category?.code || null,
      example: 'PIPES',
    },
    {
      header: 'HSN Code', field: 'hsnId', type: 'reference',
      reference: { master: 'hsnCodes', label: 'the HSN Codes master' },
      exportValue: (record) => record.hsnCode?.code || null,
      example: '6810',
    },
    { header: 'Selling Price (Rs)', field: 'sellingPricePaise', type: 'money', rate: true, example: 4500 },
    { header: 'Standard Cost (Rs)', field: 'standardCostPaise', type: 'money', rate: true, example: 3100 },
    { header: 'Reorder Level', field: 'reorderLevel', type: 'number', min: 0, example: 50 },
    { header: 'Minimum Stock', field: 'minStock', type: 'number', min: 0, example: 20 },
    { header: 'Maximum Stock', field: 'maxStock', type: 'number', min: 0, example: 500 },
    { header: 'Curing Days', field: 'curingDays', type: 'integer', min: 0, max: 365, example: 28, note: 'finished goods only' },
    { header: 'QC Required', field: 'qcRequired', type: 'boolean', example: 'Yes' },
    { header: 'Is Accessory', field: 'isAccessory', type: 'boolean', example: 'No' },
    { header: 'Default Location', field: 'defaultLocation', type: 'text', maxLength: 100, example: 'Yard A' },
    STATUS,
  ],
  examples: [
    { code: 'FG-PIPE-600', name: 'RCC Pipe 600mm NP2', productType: 'Finished Good', uomId: 'NOS', categoryId: 'PIPES', hsnId: '6810', sellingPricePaise: 4500, standardCostPaise: 3100, reorderLevel: 50, minStock: 20, maxStock: 500, curingDays: 28, qcRequired: 'Yes', isAccessory: 'No', defaultLocation: 'Yard A', status: 'Active' },
    { code: 'RM-CEM-OPC53', name: 'OPC 53 Grade Cement', productType: 'Raw Material', uomId: 'BAG', categoryId: '', hsnId: '2523', sellingPricePaise: '', standardCostPaise: 380, reorderLevel: 200, minStock: 100, maxStock: '', curingDays: 0, qcRequired: 'No', isAccessory: 'No', defaultLocation: 'Godown 1', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Product.findAll({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.productType ? { productType: query.productType } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...search(query, ['name', 'code']),
      },
      include: [
        { model: Uom, as: 'uom', attributes: ['id', 'code'] },
        { model: ProductCategory, as: 'category', attributes: ['id', 'code'] },
        { model: HsnCode, as: 'hsnCode', attributes: ['id', 'code'] },
      ],
      order: [['code', 'ASC']],
    }),
  create: (values, context, options) => ProductsService.createProduct(values, options),
  update: (record, values, context, options) => ProductsService.updateProduct(record.id, values, options),
};

const productCategories = {
  key: 'product-categories',
  label: 'Product Categories',
  fileBase: 'Product_Categories',
  resource: 'PRODUCT',
  businessKey: 'code',
  businessKeyHeader: 'Category Code',
  dependsOn: 'A parent category must already exist, so import parents before their children — or import the file twice, parents first.',
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: ID_NOTE },
    { header: 'Category Code', field: 'code', type: 'code', required: true, maxLength: 50, example: 'PIPES', note: 'unique; used to match an existing category' },
    { header: 'Category Name', field: 'name', type: 'text', required: true, maxLength: 255, example: 'RCC Pipes' },
    {
      header: 'Parent Category Code', field: 'parentId', type: 'reference',
      reference: { master: 'productCategories', label: 'the Product Categories master' },
      exportValue: (record) => record.parentCategory?.code || null,
      example: '',
    },
    { header: 'Slow Moving Days', field: 'slowMovingDays', type: 'integer', min: 0, example: 60 },
    { header: 'Dead Stock Days', field: 'deadStockDays', type: 'integer', min: 0, example: 180 },
    { header: 'Alert Before Days', field: 'alertBeforeDays', type: 'integer', min: 0, example: 7 },
    STATUS,
  ],
  examples: [
    { code: 'PIPES', name: 'RCC Pipes', parentId: '', slowMovingDays: 60, deadStockDays: 180, alertBeforeDays: 7, status: 'Active' },
    { code: 'PIPES-NP2', name: 'NP2 Class Pipes', parentId: 'PIPES', slowMovingDays: '', deadStockDays: '', alertBeforeDays: '', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    ProductCategory.findAll({
      where: { ...(query.status ? { status: query.status } : {}), ...search(query, ['name', 'code']) },
      include: [{ model: ProductCategory, as: 'parentCategory', attributes: ['id', 'code'] }],
      order: [['code', 'ASC']],
    }),
  create: (values, context, options) => ProductsService.createProductCategory(values, options),
  update: (record, values) => ProductsService.updateProductCategory(record.id, values),
};

const uoms = {
  key: 'uoms',
  label: 'Units of Measure',
  fileBase: 'Units_Of_Measure',
  resource: 'PRODUCT',
  businessKey: 'code',
  businessKeyHeader: 'Unit Code',
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: ID_NOTE },
    { header: 'Unit Code', field: 'code', type: 'code', required: true, maxLength: 20, example: 'NOS', note: 'unique; used to match an existing unit' },
    { header: 'Unit Name', field: 'name', type: 'text', required: true, maxLength: 100, example: 'Numbers' },
    { header: 'GST UQC', field: 'uqc', type: 'code', maxLength: 10, example: 'NOS', note: 'the unit code GST returns expect, e.g. NOS, MTR, KGS' },
    STATUS,
  ],
  examples: [
    { code: 'NOS', name: 'Numbers', uqc: 'NOS', status: 'Active' },
    { code: 'BAG', name: 'Bags of 50kg', uqc: 'BAG', status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Uom.findAll({
      where: { ...(query.status ? { status: query.status } : {}), ...search(query, ['name', 'code']) },
      order: [['code', 'ASC']],
    }),
  create: (values, context, options) => ProductsService.createUom(values, options),
  update: (record, values) => ProductsService.updateUom(record.id, values),
};

const hsnCodes = {
  key: 'hsn-codes',
  label: 'HSN / SAC Codes',
  fileBase: 'HSN_Codes',
  resource: 'PRODUCT',
  businessKey: 'code',
  businessKeyHeader: 'HSN / SAC Code',
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: ID_NOTE },
    { header: 'HSN / SAC Code', field: 'code', type: 'code', required: true, maxLength: 10, example: '6810', note: 'unique; 4, 6 or 8 digits for HSN' },
    { header: 'Description', field: 'description', type: 'text', maxLength: 255, example: 'Articles of cement, concrete or artificial stone' },
    {
      header: 'Code Type', field: 'codeType', type: 'enum', values: ['HSN', 'SAC'], example: 'HSN',
      note: 'HSN for goods, SAC for services',
    },
    { header: 'GST Rate %', field: 'gstRatePercent', type: 'number', required: true, min: 0, max: 100, example: 18 },
    { header: 'Cess %', field: 'cessPercent', type: 'number', min: 0, max: 100, example: 0 },
    STATUS,
  ],
  examples: [
    { code: '6810', description: 'Articles of cement, concrete or artificial stone', codeType: 'HSN', gstRatePercent: 18, cessPercent: 0, status: 'Active' },
    { code: '2523', description: 'Portland cement', codeType: 'HSN', gstRatePercent: 28, cessPercent: 0, status: 'Active' },
  ],
  load: async ({ query = {} }) =>
    HsnCode.findAll({
      where: { ...(query.status ? { status: query.status } : {}), ...search(query, ['code', 'description']) },
      order: [['code', 'ASC']],
    }),
  create: (values, context, options) => ProductsService.createHsnCode(values, options),
  update: (record, values) => ProductsService.updateHsnCode(record.id, values),
};

module.exports = { products, productCategories, uoms, hsnCodes };
