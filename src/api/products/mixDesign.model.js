const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('./product.model');

/**
 * BOM header for a finished good (BR-06: production consumes raw materials per
 * "the active mix design for that product"). Only one MixDesign per product may
 * be isActive at a time — enforced by a partial unique index in the migration
 * and by mixDesign.service.js deactivating siblings inside a transaction.
 */
class MixDesign extends BaseAuditedModel {}

MixDesign.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    // FR-M03-6: DRAFT (editable), ACTIVE (in use), SUPERSEDED (replaced but
    // permanently retained). `isActive` is kept in lock-step with status so
    // existing queries keep working, but `status` is the source of truth.
    status: {
      type: DataTypes.ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED'),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // FR-M03-8: which version applies is a function of the production DATE,
    // not of "whichever row is flagged active right now". Backdating a
    // production entry must pick the version that was in force on that date.
    effectiveFrom: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    supersededAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    supersededByMixDesignId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    outputQuantity: {
      // FR-M03-6: the BOM lines produce this many units of the parent.
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 1,
    },
    bomType: {
      // FR-M03-11: MANUFACTURING consumes inputs to create output;
      // ASSEMBLY depletes components when the parent is sold.
      type: DataTypes.ENUM('MANUFACTURING', 'ASSEMBLY'),
      allowNull: false,
      defaultValue: 'MANUFACTURING',
    },
    laborCostPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    overheadCostPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'mix_designs',
  }
);

MixDesign.belongsTo(Product, { as: 'product', foreignKey: 'productId' });

module.exports = { MixDesign };
