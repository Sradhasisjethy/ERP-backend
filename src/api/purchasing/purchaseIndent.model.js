const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');

/**
 * FR-M11-1: a factory's request to buy something, approved before it becomes a
 * purchase order.
 *
 * The indent exists so that "who asked for this and who approved it" is
 * recorded separately from "who placed the order with the vendor" — without it
 * a PO appears from nowhere and the approval step has no artefact.
 */
class PurchaseIndent extends BaseAuditedModel {}

PurchaseIndent.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    indentNumber: { type: DataTypes.STRING, allowNull: false },
    indentDate: { type: DataTypes.DATEONLY, allowNull: false },
    requiredByDate: { type: DataTypes.DATEONLY, allowNull: true },
    status: {
      type: DataTypes.ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    remarks: { type: DataTypes.TEXT, allowNull: true },
    approvedBy: { type: DataTypes.UUID, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    // Set when the indent has been turned into a PO, so it can't be converted twice.
    purchaseOrderId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    sequelize,
    version: 'lockVersion',
    tableName: 'purchase_indents',
  }
);

class PurchaseIndentLine extends BaseAuditedModel {}

PurchaseIndentLine.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    purchaseIndentId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    remarks: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    sequelize,
    tableName: 'purchase_indent_lines',
  }
);

PurchaseIndentLine.belongsTo(PurchaseIndent, { as: 'indent', foreignKey: 'purchaseIndentId' });
PurchaseIndentLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
PurchaseIndent.hasMany(PurchaseIndentLine, { as: 'lines', foreignKey: 'purchaseIndentId' });

module.exports = { PurchaseIndent, PurchaseIndentLine };
