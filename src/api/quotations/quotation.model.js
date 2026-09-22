const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { BaseScopedModel } = require('../../core/BaseModel');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { Factory } = require('../factory/factory.model');

/** A priced offer. See the migration for why a prospect can stand in for a customer. */
class Quotation extends BaseAuditedModel {}

const money = () => ({ type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });

Quotation.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    quotationNumber: { type: DataTypes.STRING, allowNull: false },
    quotationDate: { type: DataTypes.DATEONLY, allowNull: false },
    validUntil: { type: DataTypes.DATEONLY, allowNull: false },
    customerPartyId: { type: DataTypes.UUID, allowNull: true },
    prospectName: { type: DataTypes.STRING(160), allowNull: true },
    prospectPhone: { type: DataTypes.STRING(20), allowNull: true },
    prospectState: { type: DataTypes.STRING(60), allowNull: true },
    prospectGstin: { type: DataTypes.STRING(15), allowNull: true },
    status: {
      type: DataTypes.ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    discountPaise: money(),
    subtotalPaise: money(),
    cgstPaise: money(),
    sgstPaise: money(),
    igstPaise: money(),
    roundOffPaise: money(),
    totalPaise: money(),
    notes: { type: DataTypes.TEXT, allowNull: true },
    terms: { type: DataTypes.TEXT, allowNull: true },
    statusReason: { type: DataTypes.TEXT, allowNull: true },
    salesOrderId: { type: DataTypes.UUID, allowNull: true },
    leadId: { type: DataTypes.UUID, allowNull: true },
    convertedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'quotations' }
);

class QuotationLine extends BaseScopedModel {}

QuotationLine.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    quotationId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    bundleParentProductId: { type: DataTypes.UUID, allowNull: true },
    hsnCode: { type: DataTypes.STRING(20), allowNull: true },
    quantity: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    ratePaise: { type: DataTypes.BIGINT, allowNull: false },
    discountPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    discountPaise: money(),
    taxableAmountPaise: { type: DataTypes.BIGINT, allowNull: false },
    gstRatePercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    cgstPaise: money(),
    sgstPaise: money(),
    igstPaise: money(),
    lineTotalPaise: { type: DataTypes.BIGINT, allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'quotation_lines' }
);

Quotation.hasMany(QuotationLine, { as: 'lines', foreignKey: 'quotationId' });
QuotationLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
Quotation.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });
Quotation.belongsTo(Factory, { as: 'factory', foreignKey: 'factoryId' });

module.exports = { Quotation, QuotationLine };
