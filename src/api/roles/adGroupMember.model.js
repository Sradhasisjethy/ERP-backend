const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { AdGroup } = require('./role.model');

/**
 * AdGroupMember join table.
 *
 * Audited, not merely scoped. Putting a user into a role hands them every
 * permission that role carries, and taking them out removes it — which makes
 * this the most access-relevant write in the product. It was a plain scoped
 * model, so every assignment and removal happened with no record of who did it
 * or when, while the role *definition* next door was fully audited. BR-30 asks
 * for permission changes to name the user who made them; a grant made by
 * membership is a permission change.
 */
class AdGroupMember extends BaseAuditedModel {}

AdGroupMember.initAudited(
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
