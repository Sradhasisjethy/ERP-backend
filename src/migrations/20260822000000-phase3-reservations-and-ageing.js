'use strict';

/**
 * Idempotent by design: in development the server boots with
 * `sequelize.sync({ alter: true })`, so these columns may already exist by the
 * time the migration runs. Guarding each add keeps `db:migrate` usable on a
 * dev database without forcing a drop, while still building the schema
 * correctly from empty in test/production.
 */
const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

const addIndexIfMissing = async (queryInterface, table, fields, options) => {
  const existing = await queryInterface.showIndex(table);
  if (!existing.some((i) => i.name === options.name)) await queryInterface.addIndex(table, fields, options);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('stock_reservations')) {
    // --- M07: soft stock reservations ---
    await queryInterface.createTable('stock_reservations', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      lotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      referenceType: { type: Sequelize.STRING, allowNull: false, defaultValue: 'SalesOrderLine' },
      referenceId: { type: Sequelize.UUID, allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      status: { type: Sequelize.ENUM('ACTIVE', 'RELEASED', 'CONSUMED'), allowNull: false, defaultValue: 'ACTIVE' },
      releasedReason: { type: Sequelize.TEXT, allowNull: true },
      releasedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    // Availability is computed per (factory, product) filtered to ACTIVE holds
    // on nearly every sales screen — this is the index that keeps it cheap.
    await addIndexIfMissing(queryInterface, 'stock_reservations', ['tenantId', 'factoryId', 'productId', 'status'], {
      name: 'stock_reservations_availability_idx',
    });
    await addIndexIfMissing(queryInterface, 'stock_reservations', ['referenceType', 'referenceId'], {
      name: 'stock_reservations_reference_idx',
    });
    }

    // --- M22: ageing classification written by the nightly job ---
    await addColumnIfMissing(queryInterface, 'stock_lots', 'ageDays', { type: Sequelize.INTEGER, allowNull: true });
    await addColumnIfMissing(queryInterface, 'stock_lots', 'ageingClass', {
      type: Sequelize.ENUM('FRESH', 'SLOW_MOVING', 'DEAD'),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'stock_lots', 'ageingComputedAt', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'stock_lots', 'nearDeadAlertedAt', { type: Sequelize.DATE, allowNull: true });
    await addIndexIfMissing(queryInterface, 'stock_lots', ['ageingClass'], {
      name: 'stock_lots_ageing_class_idx',
    });

    // --- BR-08 early curing release audit fields ---
    await addColumnIfMissing(queryInterface, 'stock_lots', 'releasedEarlyBy', { type: Sequelize.UUID, allowNull: true });
    await addColumnIfMissing(queryInterface, 'stock_lots', 'releasedEarlyAt', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'stock_lots', 'releasedEarlyReason', { type: Sequelize.TEXT, allowNull: true });

    // --- BR-12: production requirement snapshotted on the order line ---
    await addColumnIfMissing(queryInterface, 'sales_order_lines', 'productionRequired', {
      type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0,
    });

    // --- FR-M22-1: ageing thresholds, NULL = inherit from the next level up ---
    for (const table of ['products', 'product_categories', 'factories']) {
      await addColumnIfMissing(queryInterface, table, 'slowMovingDays', { type: Sequelize.INTEGER, allowNull: true });
      await addColumnIfMissing(queryInterface, table, 'deadStockDays', { type: Sequelize.INTEGER, allowNull: true });
      await addColumnIfMissing(queryInterface, table, 'alertBeforeDays', { type: Sequelize.INTEGER, allowNull: true });
    }
  },

  async down(queryInterface) {
    for (const table of ['products', 'product_categories', 'factories']) {
      await queryInterface.removeColumn(table, 'slowMovingDays');
      await queryInterface.removeColumn(table, 'deadStockDays');
      await queryInterface.removeColumn(table, 'alertBeforeDays');
    }
    await queryInterface.removeColumn('sales_order_lines', 'productionRequired');
    for (const col of ['releasedEarlyBy', 'releasedEarlyAt', 'releasedEarlyReason', 'ageDays', 'ageingClass', 'ageingComputedAt', 'nearDeadAlertedAt']) {
      await queryInterface.removeColumn('stock_lots', col);
    }
    await queryInterface.dropTable('stock_reservations');
  },
};
