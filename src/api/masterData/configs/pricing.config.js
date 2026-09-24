const { PriceList } = require('../../pricing/priceList.model');
const { PriceListItem } = require('../../pricing/priceListItem.model');
const { Product } = require('../../products/product.model');
const { PricingService } = require('../../pricing/pricing.service');
const { NotFoundError } = require('../../../core/AppError');

/**
 * Rates, one price list at a time.
 *
 * This is the import the business actually asks for: a revised rate card
 * arrives as a spreadsheet twice a year, and typing 300 rates into a dialog is
 * how a decimal point ends up in the wrong place.
 *
 * It is the one master whose rows are children rather than records in their own
 * right, and `PricingService.updatePriceList` replaces the entire item set
 * rather than upserting a row. So instead of per-row create/update the config
 * supplies `commitAll`, which **merges** the file into the list the price list
 * already has and hands the whole set to that same service. A file holding 20
 * rates against a 300-product list therefore changes 20 rates and leaves the
 * other 280 alone — if it replaced them, a partial rate revision would silently
 * delete everything it did not mention.
 */

const priceListItems = {
  key: 'price-list-items',
  label: 'Price List Items',
  fileBase: 'Price_List',
  resource: 'PRICING',
  businessKey: 'productId',
  businessKeyHeader: 'Product Code',
  ratesRequired: true,
  context: {
    param: 'priceListId',
    label: 'price list',
    resolve: async (id) => {
      const priceList = await PriceList.findByPk(id);
      if (!priceList) throw new NotFoundError('Price list not found');
      return { id: priceList.id, name: priceList.name, priceType: priceList.priceType };
    },
  },
  dependsOn: 'Every product named here must already exist in the Products master.',
  notes: [
    { key: 'One list per file', value: 'A file belongs to the price list it was downloaded from. Rates for another list go in their own file.' },
    { key: 'Rows not in the file', value: 'Left exactly as they are. This import revises the rates you send and nothing else.' },
    { key: 'Removing a rate', value: 'Delete it on the Price Lists screen. An omitted row means "unchanged", so a file cannot remove one.' },
  ],
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new rate.' },
    {
      header: 'Product Code', field: 'productId', type: 'reference', required: true,
      reference: { master: 'products', label: 'the Products master' },
      exportValue: (record) => record.product?.code || null,
      example: 'FG-PIPE-600',
    },
    {
      header: 'Product Name', field: 'productName', type: 'text', exportOnly: true,
      exportValue: (record) => record.product?.name || null,
      note: 'shown so the file is readable; ignored on upload',
    },
    { header: 'Rate (Rs)', field: 'ratePaise', type: 'money', required: true, rate: true, example: 4500 },
    { header: 'Minimum Quantity', field: 'minQuantity', type: 'number', min: 0, example: 1 },
    { header: 'Discount %', field: 'discountPercent', type: 'number', min: 0, max: 100, example: 0 },
    { header: 'Effective From', field: 'effectiveFrom', type: 'date', example: '01/04/2026' },
  ],
  examples: [
    { productId: 'FG-PIPE-600', ratePaise: 4500, minQuantity: 1, discountPercent: 0, effectiveFrom: '01/04/2026' },
    { productId: 'FG-PIPE-900', ratePaise: 7800, minQuantity: 10, discountPercent: 2.5, effectiveFrom: '01/04/2026' },
  ],
  load: async ({ context }) =>
    PriceListItem.findAll({
      where: { priceListId: context.priceListId },
      include: [{ model: Product, as: 'product', attributes: ['id', 'code', 'name'] }],
      order: [['createdAt', 'ASC']],
    }),
  keyOf: (record) => String(record.productId),
  keyFromValues: (values) => String(values.productId || ''),

  /**
   * Merge, then hand the whole set to the service that owns the rules. The
   * import never writes a price_list_items row itself.
   */
  commitAll: async ({ rows, context }) => {
    const existing = await PriceListItem.findAll({ where: { priceListId: context.priceListId } });
    const merged = new Map(
      existing.map((item) => [
        String(item.productId),
        {
          productId: item.productId,
          ratePaise: Number(item.ratePaise),
          minQuantity: item.minQuantity === null ? undefined : Number(item.minQuantity),
          discountPercent: item.discountPercent === null ? undefined : Number(item.discountPercent),
          effectiveFrom: item.effectiveFrom || undefined,
        },
      ])
    );

    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const key = String(row.values.productId);
      const before = merged.get(key);
      if (before) updated += 1;
      else created += 1;
      merged.set(key, {
        ...(before || {}),
        productId: row.values.productId,
        ratePaise: row.values.ratePaise,
        ...(row.values.minQuantity !== undefined ? { minQuantity: row.values.minQuantity } : {}),
        ...(row.values.discountPercent !== undefined ? { discountPercent: row.values.discountPercent } : {}),
        ...(row.values.effectiveFrom !== undefined ? { effectiveFrom: row.values.effectiveFrom } : {}),
      });
    }

    await PricingService.updatePriceList(context.priceListId, { items: [...merged.values()] });
    return { created, updated };
  },
};

module.exports = { priceListItems };
