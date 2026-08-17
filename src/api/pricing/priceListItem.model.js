const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { PriceList } = require('./priceList.model');
const { Product } = require('../products/product.model');

class PriceListItem extends BaseAuditedModel {}

PriceListItem.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    priceListId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    effectiveFrom: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'price_list_items',
  }
);

PriceListItem.belongsTo(PriceList, { as: 'priceList', foreignKey: 'priceListId' });
PriceListItem.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
PriceList.hasMany(PriceListItem, { as: 'items', foreignKey: 'priceListId' });

module.exports = { PriceListItem };
