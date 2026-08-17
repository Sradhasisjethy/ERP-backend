const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { DeliveryChallan } = require('./deliveryChallan.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { Product } = require('../products/product.model');

/**
 * Which lots a line actually drew from is not duplicated here — the
 * StockLedgerEntry rows this dispatch posts (referenceType='DeliveryChallan',
 * referenceId=this challan's id) already are that record (BR-01), so a
 * second lot-consumption table would just be a second copy to keep in sync.
 */
class DeliveryChallanLine extends BaseAuditedModel {}

DeliveryChallanLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    deliveryChallanId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    salesOrderLineId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    dispatchedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'delivery_challan_lines',
  }
);

DeliveryChallanLine.belongsTo(DeliveryChallan, { as: 'deliveryChallan', foreignKey: 'deliveryChallanId' });
DeliveryChallanLine.belongsTo(SalesOrderLine, { as: 'salesOrderLine', foreignKey: 'salesOrderLineId' });
DeliveryChallanLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
DeliveryChallan.hasMany(DeliveryChallanLine, { as: 'lines', foreignKey: 'deliveryChallanId' });

module.exports = { DeliveryChallanLine };
