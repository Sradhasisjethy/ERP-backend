'use strict';

/**
 * Vehicle master.
 *
 * Delivery challans and stock transfers have always captured `vehicleNumber`
 * as free text, so the same lorry was typed a dozen different ways —
 * "OD02AB1234", "od-02-ab-1234", "OD 02 AB 1234" — and no report could group
 * by vehicle, no one could look up a transporter's details, and a typo on a
 * challan was invisible until someone tried to reconcile a freight bill.
 *
 * The documents deliberately keep storing the string. Converting
 * `deliveryChallans.vehicleNumber` and `stockTransfers.vehicleNumber` into
 * foreign keys would mean back-filling every historical row against a master
 * that did not exist when they were written, and failing whichever rows could
 * not be matched — a lot of risk to a signed, printed document for very little
 * gain. Instead the master is a lookup the forms suggest from, so new documents
 * converge on one spelling while the old ones stay exactly as they were issued.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('vehicles')) return;

    await queryInterface.createTable('vehicles', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },

      registrationNumber: { type: Sequelize.STRING, allowNull: false },
      vehicleType: {
        type: Sequelize.ENUM('TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER'),
        allowNull: false,
        defaultValue: 'TRUCK',
      },
      // Carrying capacity in the product's own stocking unit is meaningless
      // across a mixed fleet, so this is tonnes — the figure on the RC book.
      capacityTonnes: { type: Sequelize.DECIMAL(10, 3), allowNull: true },

      // Owned lorry or a hired transporter's. When hired, the transporter is a
      // Party, which is where their ledger and payments already live.
      ownership: {
        type: Sequelize.ENUM('OWNED', 'HIRED'),
        allowNull: false,
        defaultValue: 'OWNED',
      },
      transporterPartyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },

      driverName: { type: Sequelize.STRING, allowNull: true },
      driverPhone: { type: Sequelize.STRING, allowNull: true },

      // Compliance dates the transport office asks for. Nullable because a
      // plant that does not track them should not be forced to invent them.
      insuranceExpiry: { type: Sequelize.DATEONLY, allowNull: true },
      fitnessExpiry: { type: Sequelize.DATEONLY, allowNull: true },
      permitExpiry: { type: Sequelize.DATEONLY, allowNull: true },

      status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      notes: { type: Sequelize.TEXT, allowNull: true },

      createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      updatedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // One registration per tenant — the whole point is to stop the same lorry
    // existing three times under three spellings.
    await queryInterface.addIndex('vehicles', ['tenantId', 'registrationNumber'], {
      unique: true,
      name: 'vehicles_tenant_registration_unique',
    });
    await queryInterface.addIndex('vehicles', ['tenantId', 'status'], {
      name: 'vehicles_tenant_status_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('vehicles').catch(() => {});
  },
};
