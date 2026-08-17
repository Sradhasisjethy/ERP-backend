const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { SalesInvoice } = require('./salesInvoice.model');
const { DeliveryChallan } = require('../dispatch/deliveryChallan.model');

/**
 * Join table for "single & consolidated" conversion (BR-15: multiple
 * challans may be consolidated into one invoice). The unique index on
 * deliveryChallanId is what makes "once and only once" a DB-level guarantee,
 * not just an application check.
 */
class SalesInvoiceChallan extends BaseScopedModel {}

SalesInvoiceChallan.initScoped(
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
    deliveryChallanId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'sales_invoice_challans',
  }
);

SalesInvoiceChallan.belongsTo(SalesInvoice, { as: 'salesInvoice', foreignKey: 'salesInvoiceId' });
SalesInvoiceChallan.belongsTo(DeliveryChallan, { as: 'deliveryChallan', foreignKey: 'deliveryChallanId' });
SalesInvoice.hasMany(SalesInvoiceChallan, { as: 'challanLinks', foreignKey: 'salesInvoiceId' });

module.exports = { SalesInvoiceChallan };
