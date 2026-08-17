const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { StockLot } = require('./stockLot.model');
const { Product } = require('../products/product.model');

/**
 * M07 / FR-M07-1..3: a soft hold on stock for a confirmed sales order.
 *
 * A reservation deliberately writes NO stock ledger entry (AC-3.4: "no stock
 * ledger entry was created by the reservation or its release") — nothing has
 * physically moved. It only subtracts from *available* stock:
 *
 *   available = on_hand - reserved - curing - in_transit   (FR-M07-1)
 *
 * Reservations are held against specific lots in FIFO order at confirmation
 * time (FR-M07-2) so that ageing and lot traceability survive the hold, and are
 * released on dispatch (converted to an actual issue), cancellation or
 * short-close (FR-M07-3).
 */
class StockReservation extends BaseAuditedModel {}

StockReservation.initAudited(
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
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // Polymorphic owner — a sales order line today; kept generic so a future
    // production-consumption hold can use the same table.
    referenceType: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'SalesOrderLine',
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'RELEASED', 'CONSUMED'),
      allowNull: false,
      defaultValue: 'ACTIVE',
    },
    releasedReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    releasedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'stock_reservations',
  }
);

StockReservation.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });
StockReservation.belongsTo(Product, { as: 'product', foreignKey: 'productId' });

module.exports = { StockReservation };
