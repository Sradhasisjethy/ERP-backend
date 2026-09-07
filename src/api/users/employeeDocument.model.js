const { DataTypes } = require('sequelize');
const { BaseScopedModel } = require('../../core/BaseModel');
const { sequelize } = require('../../config/database');

class EmployeeDocument extends BaseScopedModel {}

EmployeeDocument.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    employeeId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'employees',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    documentType: {
      type: DataTypes.STRING,
      allowNull: false, // e.g., 'Aadhar', 'PAN', 'Resume', 'Other'
    },
    fileName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    fileKey: {
      type: DataTypes.STRING,
      allowNull: false, // The path/key in Cloudflare R2
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: true, // Size in bytes
    },
    mimeType: {
      type: DataTypes.STRING,
      allowNull: true, // e.g., 'application/pdf', 'image/jpeg'
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'employee_documents',
    timestamps: true,
  }
);

// We will define associations in the main model or here, 
// but it's best to associate it in user.model.js directly to avoid circular dependencies if possible.
const { User } = require('./user.model');
EmployeeDocument.belongsTo(User, { foreignKey: 'employeeId', as: 'employee' });

module.exports = { EmployeeDocument };
