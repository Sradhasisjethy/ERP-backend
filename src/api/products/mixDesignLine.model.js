const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { MixDesign } = require('./mixDesign.model');
const { Product } = require('./product.model');
const { Uom } = require('./uom.model');

class MixDesignLine extends BaseAuditedModel {}

MixDesignLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    mixDesignId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    rawMaterialProductId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // FR-M03-7: extra material expected to be lost handling this component.
    // Applied on top of quantityPerUnit when the BOM is exploded, so the
    // standard consumption reflects reality rather than the ideal.
    wastagePercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    isOptional: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    quantityPerUnit: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    uomId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'mix_design_lines',
  }
);

MixDesignLine.belongsTo(MixDesign, { as: 'mixDesign', foreignKey: 'mixDesignId' });
MixDesignLine.belongsTo(Product, { as: 'rawMaterial', foreignKey: 'rawMaterialProductId' });
MixDesignLine.belongsTo(Uom, { as: 'uom', foreignKey: 'uomId' });
MixDesign.hasMany(MixDesignLine, { as: 'lines', foreignKey: 'mixDesignId' });

module.exports = { MixDesignLine };
