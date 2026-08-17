const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { SalesInvoice } = require('./salesInvoice.model');
const { Product } = require('../products/product.model');

class SalesInvoiceLine extends BaseAuditedModel {}

SalesInvoiceLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    salesInvoiceId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    hsnCode: {
      // Snapshotted at invoice time — a later HSN master edit must not change history.
      type: DataTypes.STRING,
      allowNull: true,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    gstRatePercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    taxableAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    cgstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    sgstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    igstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    lineTotalPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'sales_invoice_lines',
  }
);

SalesInvoiceLine.belongsTo(SalesInvoice, { as: 'salesInvoice', foreignKey: 'salesInvoiceId' });
SalesInvoiceLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
SalesInvoice.hasMany(SalesInvoiceLine, { as: 'lines', foreignKey: 'salesInvoiceId' });

module.exports = { SalesInvoiceLine };
