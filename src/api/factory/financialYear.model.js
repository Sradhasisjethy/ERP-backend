const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Financial year, used by document numbering (BR-31: series are defined per
 * document type, per financial year) and by statutory reporting.
 */
class FinancialYear extends BaseScopedModel {}

FinancialYear.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      // e.g. "2026-27"
      type: DataTypes.STRING,
      allowNull: false,
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED'),
      defaultValue: 'PLANNED',
    },
    isCurrent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'financial_years',
  }
);

module.exports = { FinancialYear };
