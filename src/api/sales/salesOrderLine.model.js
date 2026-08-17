const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { SalesOrder } = require('./salesOrder.model');
const { Product } = require('../products/product.model');

class SalesOrderLine extends BaseAuditedModel {}

SalesOrderLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    salesOrderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    orderedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    // Updated only by the dispatch flow (Sub-milestone D). (orderedQty -
    // dispatchedQty) while the order is in an active status is this line's
    // implicit soft reservation (BR-11) — see sales.service.js.
    // BR-12 / FR-M06-4 / AC-3.1: the quantity that must be produced because it
    // cannot be met from available stock. Snapshotted at order-entry time so
    // the production sheet reflects what was actually promised, and computed
    // as orderedQty - available where "available" deliberately EXCLUDES curing
    // stock — curing stock is not available stock.
    productionRequired: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    dispatchedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'sales_order_lines',
  }
);

SalesOrderLine.belongsTo(SalesOrder, { as: 'salesOrder', foreignKey: 'salesOrderId' });
SalesOrderLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
SalesOrder.hasMany(SalesOrderLine, { as: 'lines', foreignKey: 'salesOrderId' });

module.exports = { SalesOrderLine };
