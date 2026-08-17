const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { ProductionEntry } = require('./productionEntry.model');
const { Product } = require('../products/product.model');

/**
 * BR-09: if actual consumption differs from the mix design, the user must
 * record a variance reason; variance beyond Factory.varianceThresholdPercent
 * requires supervisor approval. The raw material is consumed (ledger posted)
 * immediately regardless — the physical consumption already happened;
 * "approval" is a review/control step on the record, not a gate on the event.
 */
class MaterialConsumption extends BaseAuditedModel {}

MaterialConsumption.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    productionEntryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    rawMaterialProductId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    mixDesignQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    actualQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    variancePercent: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: false,
      defaultValue: 0,
    },
    varianceReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    requiresApproval: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    approvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    approvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'material_consumptions',
  }
);

MaterialConsumption.belongsTo(ProductionEntry, { as: 'productionEntry', foreignKey: 'productionEntryId' });
MaterialConsumption.belongsTo(Product, { as: 'rawMaterial', foreignKey: 'rawMaterialProductId' });
ProductionEntry.hasMany(MaterialConsumption, { as: 'consumptions', foreignKey: 'productionEntryId' });

module.exports = { MaterialConsumption };
