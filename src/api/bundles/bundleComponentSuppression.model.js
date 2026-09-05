const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');

/**
 * A tombstone: "this accessory was taken off this line deliberately."
 *
 * Deleting the component line alone is not enough. The next quantity change
 * re-runs expansion, expansion sees the component missing, and helpfully adds
 * it back — so the salesperson removes it again, and again. The tombstone is
 * what makes the removal stick (invariant 4), and it is checked before
 * anything else in reconcile().
 *
 * Keyed by `(parentLineId, componentProductId)`, never by order and product:
 * two lines of the same printer on one order must suppress independently.
 * That is spec test 11, and it is the thing most implementations get wrong.
 */
class BundleComponentSuppression extends BaseAuditedModel {}

BundleComponentSuppression.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    salesOrderId: { type: DataTypes.UUID, allowNull: false },
    parentLineId: { type: DataTypes.UUID, allowNull: false },
    componentProductId: { type: DataTypes.UUID, allowNull: false },

    reasonCode: { type: DataTypes.STRING(50), allowNull: false },
    reasonNote: { type: DataTypes.TEXT, allowNull: true },
    suppressedBy: { type: DataTypes.UUID, allowNull: true },
    suppressedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'bundle_component_suppressions' }
);

// No association to OverrideReasonCode is declared, deliberately. The real
// constraint is composite — (tenantId, reasonCode) references (tenantId, code),
// so a suppression cannot borrow another tenant's reason — and Sequelize cannot
// express a composite foreign key. Declaring a single-column one on `code`
// would be a lie that `sync()` then tries to create against a non-unique
// column, which fails outright. The database holds the constraint; readers
// resolve labels through OverrideReasonCode directly (see bundleReports).
BundleComponentSuppression.belongsTo(Product, { as: 'componentProduct', foreignKey: 'componentProductId' });

module.exports = { BundleComponentSuppression };
