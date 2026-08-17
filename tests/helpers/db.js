const { execFileSync } = require('child_process');
const path = require('path');
const { sequelize } = require('../../src/config/database');

const ROOT = path.resolve(__dirname, '../..');

/**
 * Builds the test schema the same way production gets it: by running the
 * migrations. Tests used to call `sequelize.sync({ force: true })`, which builds
 * the schema from the *models* instead — and the two had drifted badly (the
 * model-built schema was missing 49 indexes and 86 foreign keys, including the
 * unique indexes that stop concurrent document-number allocation handing out
 * duplicates). That meant the whole suite could pass while production-only
 * constraint violations went undetected. Migrations are now the single source
 * of truth, so a test that passes here exercises the schema that ships.
 */
const migrateFresh = () => {
  execFileSync('npx', ['sequelize-cli', 'db:migrate'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'pipe',
  });
};

const dropSchema = async () => {
  await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
};

/**
 * Per-file reset. The schema itself is built once in globalSetup; each test file
 * only needs its data cleared, which a TRUNCATE does far faster than a rebuild.
 * SequelizeMeta is excluded — wiping it would make the migration state look
 * unapplied to any later tooling.
 */
const resetDatabase = async () => {
  const [rows] = await sequelize.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'SequelizeMeta'`
  );
  if (!rows.length) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await sequelize.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
};

module.exports = { resetDatabase, migrateFresh, dropSchema };
