const { execFileSync } = require('child_process');
const path = require('path');
const { sequelize } = require('../../src/config/database');
const { resolveTestDatabase } = require('../../src/config/testDatabaseName');

const ROOT = path.resolve(__dirname, '../..');

/**
 * Refuses to wipe anything that is not the test database.
 *
 * Both operations below act on whatever `src/config/database.js` connected to,
 * and that module picks its database from NODE_ENV. Jest sets NODE_ENV to
 * 'test' only when it is not already set, so a shell that exports NODE_ENV
 * (or a CI job that sets it to anything else) leaves the connection pointed at
 * DB_NAME — the development database — while globalSetup still rebuilds the
 * _test one. The suite would then truncate ~70 tables of live data and pass,
 * which is how the development database was lost once already.
 *
 * Checking the connection itself rather than trusting NODE_ENV closes that: it
 * does not matter how the wrong database got selected, only that it is wrong.
 */
const assertTestDatabase = () => {
  const connected = sequelize.getDatabaseName();
  const expected = resolveTestDatabase();
  if (connected !== expected) {
    throw new Error(
      `Refusing to wipe "${connected}": the test helpers expected to be connected to ` +
        `"${expected}". NODE_ENV is "${process.env.NODE_ENV}" — it must be "test" for ` +
        'src/config/database.js to select the test database. Run the suite with NODE_ENV ' +
        'unset (jest sets it) or explicitly set to "test".'
    );
  }
};

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
  // Invoked through the current node binary rather than `npx`: on Windows npx
  // is a .cmd shim, and execFileSync does not spawn a shell, so calling it
  // directly throws ENOENT and the whole suite dies in setup before a single
  // test runs. require.resolve finds the CLI's own entry point in node_modules.
  execFileSync(process.execPath, [require.resolve('sequelize-cli/lib/sequelize'), 'db:migrate'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'pipe',
  });
};

const dropSchema = async () => {
  assertTestDatabase();
  await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
};

/**
 * Per-file reset. The schema itself is built once in globalSetup; each test file
 * only needs its data cleared, which a TRUNCATE does far faster than a rebuild.
 * SequelizeMeta is excluded — wiping it would make the migration state look
 * unapplied to any later tooling.
 */
const resetDatabase = async () => {
  assertTestDatabase();
  const [rows] = await sequelize.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'SequelizeMeta'`
  );
  if (!rows.length) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await sequelize.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
};

module.exports = { resetDatabase, migrateFresh, dropSchema, assertTestDatabase };
