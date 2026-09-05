const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { BundleRule } = require('./bundleRule.model');
const { Product } = require('../products/product.model');
const { Uom } = require('../products/uom.model');

class BundleComponent extends BaseAuditedModel {}

BundleComponent.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bundleRuleId: { type: DataTypes.UUID, allowNull: false },
    componentProductId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.DECIMAL(14, 4), allowNull: false },

    // PROPORTIONAL scales with the parent quantity; FIXED does not, however
    // many parents are sold — one installation kit per order, not per unit.
    scalingMode: { type: DataTypes.ENUM('PROPORTIONAL', 'FIXED'), allowNull: false, defaultValue: 'PROPORTIONAL' },
    uomId: { type: DataTypes.UUID, allowNull: false },
    isMandatory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // false = offered in the optional picker, never auto-added on expansion.
    defaultSelected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'bundle_components' }
);

BundleComponent.belongsTo(BundleRule, { as: 'bundleRule', foreignKey: 'bundleRuleId' });
BundleComponent.belongsTo(Product, { as: 'componentProduct', foreignKey: 'componentProductId' });
BundleComponent.belongsTo(Uom, { as: 'uom', foreignKey: 'uomId' });
BundleRule.hasMany(BundleComponent, { as: 'components', foreignKey: 'bundleRuleId' });

module.exports = { BundleComponent };
