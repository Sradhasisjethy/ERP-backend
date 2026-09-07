const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { resolveTestDatabase } = require('../../src/config/testDatabaseName');

const ROOT = path.resolve(__dirname, '../..');

/**
 * Runs once before the whole suite: rebuilds the schema of an existing test
 * database from the migrations. Individual test files then only truncate (see
 * helpers/db.js), which keeps a full run fast while still guaranteeing every
 * test sees the production schema — indexes, unique constraints and foreign
 * keys included.
 *
 * The database itself is not created here. It is provisioned outside the
 * codebase (AWS RDS), so the harness has no business issuing CREATE DATABASE:
 * on a managed instance the application role has no CREATEDB grant, and a test
 * run silently conjuring a database on a shared host is the wrong default
 * anyway. If it is missing, that is a provisioning step, not something to paper
 * over — so this fails with the statement to run.
 */
module.exports = async () => {
  require('dotenv').config({ path: path.join(ROOT, '.env') });

  const database = resolveTestDatabase();
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  });
  try {
    await db.connect();
  } catch (error) {
    // 3D000 is invalid_catalog_name — the server answered, the database is not
    // there. Anything else (bad password, unreachable host) is a different
    // problem and should surface as itself.
    if (error.code !== '3D000') throw error;
    throw new Error(
      `The test database "${database}" does not exist on ${process.env.DB_HOST}. ` +
        'It is provisioned outside this repository — create it, then re-run:\n\n' +
        `    CREATE DATABASE "${database}";\n\n` +
        `Grant ${process.env.DB_USER} ownership (or CREATE on the database), since the ` +
        'suite rebuilds its schema on every run.'
    );
  }

  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.end();

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
