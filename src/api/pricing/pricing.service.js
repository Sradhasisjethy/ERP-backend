const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { PriceList } = require('./priceList.model');
const { PriceListItem } = require('./priceListItem.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { Uom } = require('../products/uom.model');
const { NotFoundError } = require('../../core/AppError');

class PricingService {
  static async listPriceLists(page, limit, { search, status, priceType, partyId } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;
    if (priceType) where.priceType = priceType;
    if (partyId) where.partyId = partyId;

    return PriceList.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'party', attributes: ['id', 'name', 'code', 'partyType'] }],
      order: [['name', 'ASC']],
    });
  }

  static async getPriceList(id) {
    const priceList = await PriceList.findByPk(id, {
      include: [
        { model: Party, as: 'party', attributes: ['id', 'name', 'code', 'partyType'] },
        {
          model: PriceListItem,
          as: 'items',
          include: [{ model: Product, as: 'product', include: [{ model: Uom, as: 'uom' }] }],
        },
      ],
    });
    if (!priceList) throw new NotFoundError('Price list not found');
    return priceList;
  }

  static async createPriceList({ items, ...data }) {
    return sequelize.transaction(async (transaction) => {
      const priceList = await PriceList.create(data, { transaction });
      if (items && items.length) {
        await PriceListItem.bulkCreate(
          items.map((item) => ({ ...item, priceListId: priceList.id })),
          { transaction, individualHooks: true, validate: true }
        );
      }
      return this.getPriceList(priceList.id);
    });
  }

  static async updatePriceList(id, { items, ...data }) {
    const priceList = await this.getPriceList(id);

    return sequelize.transaction(async (transaction) => {
      await priceList.update(data, { transaction });

      if (items) {
        await PriceListItem.destroy({ where: { priceListId: id }, transaction });
        await PriceListItem.bulkCreate(
          items.map((item) => ({ ...item, priceListId: id })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      return this.getPriceList(id);
    });
  }

  static async deletePriceList(id) {
    const priceList = await this.getPriceList(id);
    await priceList.destroy();
    return true;
  }

  // Resolves the effective rate for a product, preferring a party-specific
  // list over the tenant's default list for the given priceType. Used by
  // Sales Order line-item pricing in a later milestone.
  static async resolveRate(productId, { partyId, priceType = 'RETAIL' } = {}) {
    let item = null;

    if (partyId) {
      item = await PriceListItem.findOne({
        where: { productId },
        include: [{ model: PriceList, as: 'priceList', where: { partyId, status: 'active' }, required: true }],
      });
    }

    if (!item) {
      item = await PriceListItem.findOne({
        where: { productId },
        include: [
          { model: PriceList, as: 'priceList', where: { priceType, partyId: null, status: 'active' }, required: true },
        ],
      });
    }

    if (item) return item.ratePaise;

    // Last resort: the price on the product itself.
    //
    // `products.sellingPricePaise` is where someone naturally records what an
    // item sells for, and a small catalogue may have no price lists at all.
    // Returning null here meant an accessory with a perfectly good selling
    // price was pulled onto an order at zero — free, silently, all the way to
    // the invoice.
    //
    // Only for RETAIL. A CONTRACTOR_RATE is a piece rate paid for work done,
    // not a selling price, and falling back to what the item sells for would
    // overpay every labour bill.
    if (priceType === 'RETAIL') {
      const product = await Product.findByPk(productId, { attributes: ['sellingPricePaise'] });
      const selling = Number(product?.sellingPricePaise || 0);
      if (selling > 0) return selling;
    }

    return null;
  }

  // --- Individual price list items ---
  static async upsertItem(priceListId, { productId, ratePaise, effectiveFrom }) {
    await this.getPriceList(priceListId);
    const [item] = await PriceListItem.findOrCreate({
      where: { priceListId, productId },
      defaults: { priceListId, productId, ratePaise, effectiveFrom },
    });
    await item.update({ ratePaise, effectiveFrom });
    return item;
  }

  static async removeItem(priceListId, productId) {
    const item = await PriceListItem.findOne({ where: { priceListId, productId } });
    if (!item) throw new NotFoundError('Price list item not found');
    await item.destroy();
    return true;
  }
}

module.exports = { PricingService };
