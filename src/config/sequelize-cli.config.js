// Plain-JS config consumed by sequelize-cli (`npm run migrate`). Kept separate from
// env.js because sequelize-cli loads this file directly, before any zod validation runs.
require('dotenv').config();
const { resolveTestDatabase } = require('./testDatabaseName');

const base = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  dialect: 'postgres',
};

module.exports = {
  development: {
    ...base,
    database: process.env.DB_NAME,
    logging: console.log,
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
