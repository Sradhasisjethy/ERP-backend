const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');

/**
 * A sales bundle: parent product X implies accessories a1, b1, c1 as separate
 * billable lines. See docs/specs/bundle-kitting.md.
 *
 * Deliberately NOT the same table as MixDesign, which is structurally similar
 * (parent explodes into components, versioned, date-effective). A mix design is
 * a manufacturing recipe consumed by a casting run; a bundle is a sales kit that
 * becomes billable lines the customer sees and can decline. Merging them would
 * mean one edit to a recipe silently changing what a salesperson quotes.
 */
class BundleRule extends BaseAuditedModel {}

BundleRule.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    code: { type: DataTypes.STRING(50), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    parentProductId: { type: DataTypes.UUID, allowNull: false },

    // Only EXPLODED / INDEPENDENT are implemented; the other values exist so
    // assembled kits and composite supply have somewhere to land later.
    bundleType: { type: DataTypes.ENUM('EXPLODED', 'ASSEMBLED'), allowNull: false, defaultValue: 'EXPLODED' },
    taxTreatment: { type: DataTypes.ENUM('INDEPENDENT', 'COMPOSITE', 'MIXED'), allowNull: false, defaultValue: 'INDEPENDENT' },

    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    status: { type: DataTypes.ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'), allowNull: false, defaultValue: 'DRAFT' },
    effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false },
    effectiveTo: { type: DataTypes.DATEONLY, allowNull: true },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    publishedBy: { type: DataTypes.UUID, allowNull: true },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'bundle_rules' }
);

BundleRule.belongsTo(Product, { as: 'parentProduct', foreignKey: 'parentProductId' });

module.exports = { BundleRule };
