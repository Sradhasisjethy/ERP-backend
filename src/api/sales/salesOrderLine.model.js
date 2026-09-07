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

    // ---- product bundles (docs/specs/bundle-kitting.md) -------------------
    //
    // Every column below defaults to the shape of an ordinary line, so an order
    // raised without a bundle in sight behaves exactly as it did before: role
    // STANDALONE, no parent, origin MANUAL, syncState SYNCED.

    lineRole: {
      type: DataTypes.ENUM('PARENT', 'COMPONENT', 'STANDALONE'),
      allowNull: false,
      defaultValue: 'STANDALONE',
    },
    // Self-reference. A COMPONENT points at the PARENT it was expanded under —
    // NOT at the order — because two lines of the same product on one order
    // must carry independent accessories (invariant 8, spec test 11).
    parentLineId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    bundleRuleId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    bundleRuleVersion: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // The rule frozen as it stood when this line was expanded (invariant 3).
    // Reading a historical order must never re-resolve against live master
    // data: editing a rule cannot retroactively change what a customer was
    // quoted last March.
    bundleSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    origin: {
      type: DataTypes.ENUM('RULE_AUTO', 'RULE_OPTIONAL', 'MANUAL'),
      allowNull: false,
      defaultValue: 'MANUAL',
    },
    // Whether the system still owns this line's numbers. Anything other than
    // SYNCED means a human typed something here, and expansion must not
    // overwrite it (invariant 5).
    syncState: {
      type: DataTypes.ENUM('SYNCED', 'QTY_OVERRIDDEN', 'PRICE_OVERRIDDEN', 'DETACHED'),
      allowNull: false,
      defaultValue: 'SYNCED',
    },
    // What the rule would say today. Kept current even on an overridden line —
    // it is what the variance badge compares against and what "reset to
    // suggested" restores.
    systemQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    systemUnitPricePaise: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'sales_order_lines',
  }
);

SalesOrderLine.belongsTo(SalesOrder, { as: 'salesOrder', foreignKey: 'salesOrderId' });
// The parent/child relationship is within the line table itself.
SalesOrderLine.belongsTo(SalesOrderLine, { as: 'parentLine', foreignKey: 'parentLineId' });
SalesOrderLine.hasMany(SalesOrderLine, { as: 'componentLines', foreignKey: 'parentLineId' });
SalesOrderLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
SalesOrder.hasMany(SalesOrderLine, { as: 'lines', foreignKey: 'salesOrderId' });

module.exports = { SalesOrderLine };
