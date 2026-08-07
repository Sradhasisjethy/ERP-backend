const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { AdGroup } = require('./role.model');

/**
 * AdGroupMember join table.
 */
class AdGroupMember extends BaseScopedModel {}

AdGroupMember.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    adGroupId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    employeeId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'ad_group_members',
  }
);

AdGroupMember.belongsTo(AdGroup, { foreignKey: 'adGroupId' });
AdGroup.hasMany(AdGroupMember, { foreignKey: 'adGroupId' });

module.exports = { AdGroupMember };
