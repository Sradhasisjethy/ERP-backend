const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { SalesOrder } = require('../sales/salesOrder.model');
const { Factory } = require('../factory/factory.model');

/**
 * M15: dispatch document. Created directly in DISPATCHED status (mirrors the
 * GRN pattern — the goods physically left, so the document records a fact
 * that already happened, not a draft). BR-15: a challan converts to a Tax
 * Invoice once and only once — `invoiced`/`invoicedAt` are the flag M20/M21
 * (Phase 2) will set; there is no conversion action yet because there is no
 * invoice model yet.
 */
class DeliveryChallan extends BaseAuditedModel {}

DeliveryChallan.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    challanNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    salesOrderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    vehicleNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    driverName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    dispatchDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('DISPATCHED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'DISPATCHED',
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    invoiced: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    invoicedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'delivery_challans',
  }
);

DeliveryChallan.belongsTo(SalesOrder, { as: 'salesOrder', foreignKey: 'salesOrderId' });
// The dispatching plant, for the letterhead and for the state that decides
// whether a movement is inter- or intra-state.
DeliveryChallan.belongsTo(Factory, { as: 'factory', foreignKey: 'factoryId' });

module.exports = { DeliveryChallan };
