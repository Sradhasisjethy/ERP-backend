const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Uom } = require('./uom.model');

/**
 * FR-M03-2: a conversion between two units of measure, e.g.
 *   1 Bag = 50 Kg      -> fromUom=Bag, toUom=Kg, factor=50
 *   1 CFT = 0.0283 CUM -> fromUom=CFT, toUom=CUM, factor=0.0283
 *
 * Stored one-directional and inverted on demand (see UomService.convert), so a
 * pair can never be defined inconsistently in the two directions — defining
 * both 1 Bag = 50 Kg and 1 Kg = 0.019 Kg would silently disagree.
 *
 * factor is NUMERIC(18,8) rather than the (18,4) used for quantities: a
 * conversion factor is a ratio that gets multiplied through, so rounding it to
 * 4dp (0.0283 CUM/CFT) compounds error across a whole BOM explosion.
 */
class UomConversion extends BaseAuditedModel {}

UomConversion.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fromUomId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    toUomId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    factor: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
      validate: { min: { args: [1e-8], msg: 'Conversion factor must be greater than zero' } },
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      defaultValue: 'active',
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'uom_conversions',
  }
);

UomConversion.belongsTo(Uom, { as: 'fromUom', foreignKey: 'fromUomId' });
UomConversion.belongsTo(Uom, { as: 'toUom', foreignKey: 'toUomId' });

module.exports = { UomConversion };
