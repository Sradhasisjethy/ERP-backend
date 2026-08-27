const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '../..');

/**
 * Runs once before the whole suite: rebuilds the test database from the
 * migrations. Individual test files then only truncate (see helpers/db.js),
 * which keeps a full run fast while still guaranteeing every test sees the
 * production schema — indexes, unique constraints and foreign keys included.
 */
module.exports = async () => {
  require('dotenv').config({ path: path.join(ROOT, '.env') });

  const database = process.env.DB_NAME_TEST || `${process.env.DB_NAME}_test`;
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });

  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (!rows.length) await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  });
  await db.connect();
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
