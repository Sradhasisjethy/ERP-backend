// Plain-JS config consumed by sequelize-cli (`npm run migrate`). Kept separate from
// env.js because sequelize-cli loads this file directly, before any zod validation runs.
require('dotenv').config();
const { resolveTestDatabase } = require('./testDatabaseName');
const { dbSslOptions } = require('./dbSsl');

// Migrations change the schema, so they may run as a more privileged role than
// the application (docs/db-least-privilege.md). When DB_MIGRATOR_USER is set it
// is used here; the running app always connects as DB_USER, which then needs
// only data rights. Unset, both use DB_USER exactly as before.
const base = {
  username: process.env.DB_MIGRATOR_USER || process.env.DB_USER,
  password: process.env.DB_MIGRATOR_USER ? process.env.DB_MIGRATOR_PASSWORD : process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  dialect: 'postgres',
  dialectOptions: dbSslOptions(process.env),
};

module.exports = {
  development: {
    ...base,
    database: process.env.DB_NAME,
    // Opt-in for the same reason as src/config/database.js.
    logging: process.env.DB_LOG_SQL === 'true' ? console.log : false,
  },
  test: {
    ...base,
    // Shares one resolver with the Sequelize connection and the Jest
    // globalSetup — this line used to fall back to DB_NAME, which pointed
    // `db:migrate` at the development database whenever DB_NAME_TEST was unset.
    database: resolveTestDatabase(),
    logging: false,
  },
  production: {
    ...base,
    database: process.env.DB_NAME,
    logging: false,
  },
};
