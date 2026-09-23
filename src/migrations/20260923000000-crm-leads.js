'use strict';

/**
 * Leads and the follow-ups against them.
 *
 * An enquiry is not a customer and not an order: it is someone who might buy,
 * and the thing that decides whether they do is whether anyone follows up. So
 * the activity trail (calls, site visits, notes, tasks with a due date) is
 * half of this feature, not an afterthought.
 *
 * `quotations.leadId` closes the loop: quoting a lead marks it quoted, and the
 * quotation's own conversion to a sales order is what eventually wins it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('leads')) {
      await queryInterface.createTable('leads', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        leadNumber: { type: Sequelize.STRING, allowNull: false },
        name: { type: Sequelize.STRING(160), allowNull: false },
        contactName: { type: Sequelize.STRING(120), allowNull: true },
        phone: { type: Sequelize.STRING(20), allowNull: true },
        email: { type: Sequelize.STRING(160), allowNull: true },
        city: { type: Sequelize.STRING(80), allowNull: true },
        state: { type: Sequelize.STRING(60), allowNull: true },
        source: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'OTHER' },
        status: { type: Sequelize.ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'WON', 'LOST'), allowNull: false, defaultValue: 'NEW' },
        // What the enquiry might be worth, as judged by whoever took it.
        estimatedValuePaise: { type: Sequelize.BIGINT, allowNull: true },
        expectedCloseDate: { type: Sequelize.DATEONLY, allowNull: true },
        ownerId: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        requirement: { type: Sequelize.TEXT, allowNull: true },
        lostReason: { type: Sequelize.TEXT, allowNull: true },
        // Set when the lead becomes a customer on the books.
        customerPartyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'SET NULL' },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('leads', ['tenantId', 'leadNumber'], { unique: true, name: 'leads_tenant_number_unique' });
      await queryInterface.addIndex('leads', ['tenantId', 'status'], { name: 'leads_tenant_status' });
    }

    if (!tables.includes('lead_activities')) {
      await queryInterface.createTable('lead_activities', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        leadId: { type: Sequelize.UUID, allowNull: false, references: { model: 'leads', key: 'id' }, onDelete: 'CASCADE' },
        type: { type: Sequelize.ENUM('NOTE', 'CALL', 'MEETING', 'EMAIL', 'SITE_VISIT', 'TASK'), allowNull: false },
        subject: { type: Sequelize.STRING(200), allowNull: false },
        detail: { type: Sequelize.TEXT, allowNull: true },
        // When it happened, or when it is due for a TASK.
        occurredAt: { type: Sequelize.DATE, allowNull: true },
        dueDate: { type: Sequelize.DATEONLY, allowNull: true },
        completedAt: { type: Sequelize.DATE, allowNull: true },
        assignedTo: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('lead_activities', ['tenantId', 'leadId'], { name: 'lead_activities_tenant_lead' });
      await queryInterface.addIndex('lead_activities', ['tenantId', 'dueDate'], { name: 'lead_activities_tenant_due' });
    }

    const quotations = await queryInterface.describeTable('quotations');
    if (!quotations.leadId) {
      await queryInterface.addColumn('quotations', 'leadId', {
        type: Sequelize.UUID, allowNull: true, references: { model: 'leads', key: 'id' }, onDelete: 'SET NULL',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('quotations', 'leadId').catch(() => {});
    await queryInterface.dropTable('lead_activities').catch(() => {});
    await queryInterface.dropTable('leads').catch(() => {});
    for (const type of ['enum_lead_activities_type', 'enum_leads_status']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
  },
};
