const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * A lorry in the fleet (owned) or one a transporter sends regularly (hired).
 *
 * Delivery challans and stock transfers still store `vehicleNumber` as text —
 * see the migration for why. This master exists so those forms can suggest a
 * consistent spelling and so someone can look the vehicle up.
 */
class Vehicle extends BaseAuditedModel {}

Vehicle.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    registrationNumber: { type: DataTypes.STRING, allowNull: false },
    vehicleType: {
      type: DataTypes.ENUM('TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER'),
      allowNull: false,
      defaultValue: 'TRUCK',
    },
    capacityTonnes: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    ownership: { type: DataTypes.ENUM('OWNED', 'HIRED'), allowNull: false, defaultValue: 'OWNED' },
    transporterPartyId: { type: DataTypes.UUID, allowNull: true },
    driverName: { type: DataTypes.STRING, allowNull: true },
    driverPhone: { type: DataTypes.STRING, allowNull: true },
    insuranceExpiry: { type: DataTypes.DATEONLY, allowNull: true },
    fitnessExpiry: { type: DataTypes.DATEONLY, allowNull: true },
    permitExpiry: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    notes: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'vehicles' }
);

Vehicle.belongsTo(Party, { as: 'transporter', foreignKey: 'transporterPartyId' });

module.exports = { Vehicle };
