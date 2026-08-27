'use strict';

/**
 * Quality control (QC-01).
 *
 * The system had no quality discipline of any kind: a search for "quality",
 * "inspection" or "rework" across the whole backend returned one unrelated
 * comment. Two concrete consequences:
 *
 *   1. Goods receipt lines carried only `receivedQty`, so EVERYTHING a supplier
 *      delivered went straight into available stock — including material a
 *      storekeeper would have quarantined at the gate.
 *
 *   2. A finished lot was withheld for `curingDays` and then released by a
 *      timer, with no test result gating it. For structural concrete, strength
 *      testing is what decides whether a pour may ship, and it is frequently a
 *      contractual and regulatory obligation.
 *
 * Everything here is additive and defaults to today's behaviour:
 *
 *   - `acceptedQty` defaults to `receivedQty`, so a receipt that says nothing
 *     about quality still stocks the full delivery exactly as before.
 *   - `factories.qcHoldEnabled` defaults FALSE, so no lot is held for testing
 *     until a plant opts in.
 *   - `products.qcRequired` defaults FALSE, so even inside an opted-in factory
 *     only the products that need testing are held.
 *
 * Test ages are stored per result (`testAgeDays`) rather than hardcoded to
 * 7/28, so a plant with a different regime is not forced into ours.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    // --- lot lifecycle: two new resting places -----------------------------
    // Reusing StockLot.status rather than adding a parallel qcStatus column is
    // deliberate: every existing query that selects `status: 'AVAILABLE'` —
    // FIFO consumption, availability, dispatch, reports — then excludes held
    // and failed stock automatically, with no call site left to remember.
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_stock_lots_status" ADD VALUE IF NOT EXISTS 'QC_HOLD';`
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_stock_lots_status" ADD VALUE IF NOT EXISTS 'QC_FAILED';`
    );

    // --- opt-in switches ---------------------------------------------------
    const factoryCols = await queryInterface.describeTable('factories');
    if (!factoryCols.qcHoldEnabled) {
      await queryInterface.addColumn('factories', 'qcHoldEnabled', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    const productCols = await queryInterface.describeTable('products');
    if (!productCols.qcRequired) {
      await queryInterface.addColumn('products', 'qcRequired', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    // --- incoming inspection ----------------------------------------------
    const grnCols = await queryInterface.describeTable('goods_receipt_lines');
    if (!grnCols.acceptedQty) {
      // Nullable first so the backfill can distinguish "not yet set" from a
      // real zero, then filled from receivedQty and made NOT NULL.
      await queryInterface.addColumn('goods_receipt_lines', 'acceptedQty', {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: true,
      });
      await queryInterface.sequelize.query(
        `UPDATE "goods_receipt_lines" SET "acceptedQty" = "receivedQty" WHERE "acceptedQty" IS NULL;`
      );
      await queryInterface.changeColumn('goods_receipt_lines', 'acceptedQty', {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
      });
    }
    if (!grnCols.rejectedQty) {
      await queryInterface.addColumn('goods_receipt_lines', 'rejectedQty', {
        type: Sequelize.DECIMAL(14, 4),
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!grnCols.rejectionReason) {
      await queryInterface.addColumn('goods_receipt_lines', 'rejectionReason', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }

    // --- inspection records ------------------------------------------------
    if (!tables.includes('quality_inspections')) {
      await queryInterface.createTable('quality_inspections', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
        inspectionNumber: { type: Sequelize.STRING, allowNull: false },

        // INCOMING  — supplier material at the gate (references a goods receipt)
        // IN_PROCESS — a check during production
        // FINAL      — the test that releases a finished lot for dispatch
        inspectionType: {
          type: Sequelize.ENUM('INCOMING', 'IN_PROCESS', 'FINAL'),
          allowNull: false,
        },

        productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
        // The lot under test. Null for an INCOMING inspection recorded before
        // the material is stocked.
        lotId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
        goodsReceiptId: { type: Sequelize.UUID, allowNull: true, references: { model: 'goods_receipts', key: 'id' }, onDelete: 'RESTRICT' },
        productionEntryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'production_entries', key: 'id' }, onDelete: 'RESTRICT' },

        // Age at test, in days from the lot's origin date. Stored per result so
        // a 7-day and a 28-day cube are two rows against the same lot, and a
        // plant on a different regime is not forced into ours.
        testAgeDays: { type: Sequelize.INTEGER, allowNull: true },
        sampleRef: { type: Sequelize.STRING, allowNull: true },

        // The measurement and the threshold it was judged against, both stored
        // rather than recomputed — a spec that changes later must not silently
        // rewrite the verdict on a test taken last year.
        testedValue: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
        requiredValue: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
        unitLabel: { type: Sequelize.STRING, allowNull: true },

        result: {
          type: Sequelize.ENUM('PENDING', 'PASS', 'FAIL'),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        quantityInspected: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
        quantityRejected: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },

        inspectionDate: { type: Sequelize.DATEONLY, allowNull: false },
        recordedOn: { type: Sequelize.DATE, allowNull: true },
        remarks: { type: Sequelize.TEXT, allowNull: true },

        inspectedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },

        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });

      await queryInterface.addIndex('quality_inspections', ['tenantId', 'inspectionNumber'], {
        unique: true,
        name: 'quality_inspections_tenant_number_unique',
      });
      await queryInterface.addIndex('quality_inspections', ['tenantId', 'factoryId', 'inspectionDate'], {
        name: 'quality_inspections_tenant_factory_date_idx',
      });
      await queryInterface.addIndex('quality_inspections', ['tenantId', 'lotId'], {
        name: 'quality_inspections_tenant_lot_idx',
      });
      // The "what is waiting on me today" query the pending list runs.
      await queryInterface.addIndex('quality_inspections', ['tenantId', 'result'], {
        name: 'quality_inspections_tenant_result_idx',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('quality_inspections').catch(() => {});
    await queryInterface.removeColumn('goods_receipt_lines', 'rejectionReason').catch(() => {});
    await queryInterface.removeColumn('goods_receipt_lines', 'rejectedQty').catch(() => {});
    await queryInterface.removeColumn('goods_receipt_lines', 'acceptedQty').catch(() => {});
    await queryInterface.removeColumn('products', 'qcRequired').catch(() => {});
    await queryInterface.removeColumn('factories', 'qcHoldEnabled').catch(() => {});
    // Postgres cannot drop a value from an enum type; QC_HOLD and QC_FAILED
    // are left in place. They are inert once no lot references them.
  },
};
