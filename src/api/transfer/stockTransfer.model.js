const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * Inter-factory movement (BR-14: multi-location stock with inter-factory
 * transfer, incl. in-transit). Status IN_TRANSIT *is* the in-transit record —
 * stock reports can join on this table to show "N units in transit to
 * Factory X" without needing a phantom ledger row for a state that isn't a
 * location.
 */
class StockTransfer extends BaseAuditedModel {}

StockTransfer.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fromFactoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    toFactoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    transferNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    vehicleNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    initiatedDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    receivedDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('IN_TRANSIT', 'RECEIVED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'IN_TRANSIT',
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'stock_transfers',
  }
);

module.exports = { StockTransfer };
