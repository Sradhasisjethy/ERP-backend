const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Tracks the next sequence number for a (documentType, factory, financial year)
 * combination (BR-31: gap-free, per series, per document type, per FY,
 * optionally per factory). Rows are only ever mutated through
 * documentNumbering.service.js under a row lock (BR-32) — never edited directly.
 */
class DocumentSeries extends BaseScopedModel {}

DocumentSeries.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    documentType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    financialYearId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    prefix: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    nextSequence: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    padding: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 4,
    },
  },
  {
    sequelize,
    tableName: 'document_series',
  }
);

module.exports = { DocumentSeries };
