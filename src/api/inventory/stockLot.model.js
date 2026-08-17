const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');

/**
 * A lot is the unit of stock traceability (BR-02): created by production or
 * goods receipt, carries its own origin date, and is consumed FIFO by lot
 * (BR-03). curingDays/originDate are snapshotted onto the lot at creation
 * time (not read live from Product) so a later change to a product's curing
 * period never retroactively changes a lot that's already curing.
 *
 * Status lifecycle: CURING -> AVAILABLE (BR-08, promoted automatically once
 * originDate + curingDays is reached — see StockLedgerService.promoteEligibleLots)
 * -> CONSUMED (qtyAvailable hits 0). WITH_CONTRACTOR and IN_TRANSIT are set
 * explicitly by the contractor job-work and transfer flows respectively.
 */
class StockLot extends BaseAuditedModel {}

StockLot.initAudited(
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
    lotNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    originType: {
      type: DataTypes.ENUM('PRODUCTION', 'PURCHASE', 'TRANSFER_IN', 'SALES_RETURN', 'CONTRACTOR_ISSUE'),
      allowNull: false,
    },
    originId: {
      // Polymorphic: ProductionEntry.id, GoodsReceiptLine.id, StockTransferLine.id,
      // SalesReturn.id, or ContractorMaterialIssue.id depending on originType.
      // No FK constraint — the referenced table varies.
      type: DataTypes.UUID,
      allowNull: false,
    },
    // BR-23: material issued to a contractor for job work "remains BPL stock,
    // tracked in a separate 'With Contractor' location" — set only when
    // status is WITH_CONTRACTOR, identifying which contractor is holding it.
    heldByPartyId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    originDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    curingDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.ENUM('CURING', 'AVAILABLE', 'WITH_CONTRACTOR', 'IN_TRANSIT', 'CONSUMED'),
      allowNull: false,
      defaultValue: 'AVAILABLE',
    },
    qtyOriginal: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    qtyAvailable: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    // --- M22 ageing (FR-M22-2..4) ---
    // Written by the nightly classification job so dead-stock reports and
    // dashboards read a column instead of recomputing age per row. Age is
    // always measured from originDate, never from the last movement and never
    // reset by a transfer (FR-M14-9) — otherwise dead stock could be hidden by
    // shuttling it between factories.
    ageDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    ageingClass: {
      type: DataTypes.ENUM('FRESH', 'SLOW_MOVING', 'DEAD'),
      allowNull: true,
    },
    ageingComputedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Set once a near-dead alert has fired for this lot, so the nightly job
    // stays idempotent and doesn't re-alert every night (FR-M24-5, AC-13.3).
    nearDeadAlertedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // --- BR-08 early curing release (AC-4.4) ---
    releasedEarlyBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    releasedEarlyAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    releasedEarlyReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'stock_lots',
  }
);

StockLot.belongsTo(Product, { as: 'product', foreignKey: 'productId' });

module.exports = { StockLot };
