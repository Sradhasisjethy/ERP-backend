const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * BR-11: reserves stock softly — reservation never reduces StockLot
 * quantities, it only reduces available-to-promise (see
 * sales.service.js#getAvailableToPromise, which nets open order lines
 * against on-hand AVAILABLE stock on the fly rather than persisting a
 * separate "reserved" counter that could drift out of sync).
 */
class SalesOrder extends BaseAuditedModel {}

SalesOrder.initAudited(
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
    orderNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    orderDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    // FR-M06-1: the promised delivery date, used by the nightly job to flag
    // orders that have slipped past it (FR-M24-2).
    expectedDeliveryDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    poReferenceNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // BR-28: customer PO attachments are visible only to roles explicitly
    // granted attachment access — enforced in sales.controller.js, not by
    // hiding the field client-side.
    poAttachmentPath: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'SHORT_CLOSED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    totalAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    shortCloseReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    shortClosedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'sales_orders',
  }
);

SalesOrder.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });

module.exports = { SalesOrder };
