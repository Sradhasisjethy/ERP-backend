const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { Notification } = require('./notification.model');
const { User } = require('../users/user.model');

/**
 * One user's read receipt for a broadcast notification.
 *
 * A broadcast (userId null) is a single row everyone in its audience shares,
 * so it cannot carry "read" itself without reading it for the whole tenant.
 * Personal notifications still use their own `readAt`; see
 * notifications.service.js for how the two combine.
 */
class NotificationRead extends BaseScopedModel {}

NotificationRead.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    notificationId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'notification_reads',
    indexes: [
      { unique: true, fields: ['notificationId', 'userId'], name: 'notification_reads_notification_user_unique' },
      { fields: ['tenantId', 'userId'], name: 'notification_reads_tenant_user_idx' },
    ],
  }
);

// hasOne, not hasMany: the service always joins on (notification, caller), and
// the unique index guarantees at most one such row. A hasMany include would make
// Sequelize split list queries into a limited subquery, breaking the ordering.
Notification.hasOne(NotificationRead, { foreignKey: 'notificationId', as: 'myRead' });
NotificationRead.belongsTo(Notification, { foreignKey: 'notificationId' });
NotificationRead.belongsTo(User, { foreignKey: 'userId' });

module.exports = { NotificationRead };
