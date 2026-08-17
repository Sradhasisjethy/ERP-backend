const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

const NOTIFICATION_TYPES = [
  'NEGATIVE_STOCK',
  'DEAD_STOCK',
  'NEAR_DEAD_STOCK',
  'REORDER_LEVEL',
  'OVERDUE_RECEIVABLE',
  'CREDIT_LIMIT_BREACH',
  'ORDER_PAST_DELIVERY_DATE',
  'CURING_COMPLETE',
  'EARLY_CURING_RELEASE',
  'NEGATIVE_CASH',
  'STALE_RESERVATION',
  'VARIANCE_APPROVAL_PENDING',
  'LEDGER_BALANCE_DRIFT',
  'JOB_FAILED',
];

/**
 * M24: a persisted, in-app notification.
 *
 * Alerts are raised by scheduled jobs (see src/jobs/) which re-run on the same
 * data every night, so every alert carries a `dedupeKey`. That key is unique
 * per tenant, which is what makes FR-M24-5 / AC-13.3 true: the same condition
 * on the same record produces one notification, not one per night, until it is
 * explicitly re-armed by the condition clearing.
 *
 * Extends BaseScopedModel rather than BaseAuditedModel: a notification being
 * marked read is not a business event worth an audit row, and the volume would
 * swamp the audit log.
 */
class Notification extends BaseScopedModel {}

Notification.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(...NOTIFICATION_TYPES),
      allowNull: false,
    },
    severity: {
      type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'),
      allowNull: false,
      defaultValue: 'MEDIUM',
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    // BR-27: money never goes in the message prose — prose can't be masked.
    // Amounts belong in `metadata`, which the controller masks per permission.
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Deep link target (FR-M24-1).
    entityType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    entityId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Null = broadcast to every user who can see the factory; set = personal.
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    dedupeKey: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'notifications',
    indexes: [
      { unique: true, fields: ['tenantId', 'dedupeKey'], name: 'notifications_tenant_dedupe_unique' },
      { fields: ['tenantId', 'readAt'], name: 'notifications_tenant_unread_idx' },
    ],
  }
);

module.exports = { Notification, NOTIFICATION_TYPES };
