// Plain-JS config consumed by sequelize-cli (`npm run migrate`). Kept separate from
// env.js because sequelize-cli loads this file directly, before any zod validation runs.
require('dotenv').config();

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
    database: process.env.DB_NAME_TEST || process.env.DB_NAME,
    logging: false,
  },
  production: {
    ...base,
    database: process.env.DB_NAME,
    logging: false,
  },
};
