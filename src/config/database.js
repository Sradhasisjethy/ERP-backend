const { Sequelize } = require('sequelize');
const { env } = require('./env');
const cls = require('cls-hooked');
const { NAMESPACE_NAME } = require('../core/tenantContext');
const { resolveTestDatabase } = require('./testDatabaseName');

// Use cls-hooked for Sequelize transactions and hooks
Sequelize.useCLS(cls.createNamespace(NAMESPACE_NAME));

// Tests run against a separate database so `sequelize.sync({ force: true })` in test
// setup never touches development data.
const database = env.NODE_ENV === 'test' ? resolveTestDatabase(env) : env.DB_NAME;

const sequelize = new Sequelize({
  dialect: 'postgres',
  host: env.DB_HOST,
  port: parseInt(env.DB_PORT, 10),
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database,
  /**
   * Without this Sequelize pins the connection to UTC, whatever the server is
   * set to — `current_setting('TimeZone')` came back as `<+00>-00` on a server
   * configured for Asia/Kolkata.
   *
   * That is not cosmetic. CURRENT_DATE appears in ten report expressions
   * (receivables ageing, overdue sales orders, days pending, stock ageing, dead
   * stock) and the curing promotion compares originDate + curingDays against
   * NOW(). Under UTC every one of them reads the previous day between 00:00 and
   * 05:30 IST — an invoice due today reports as overdue, and a lot that
   * finished curing at midnight stays unsellable until half past five. It is
   * the same off-by-one that made the dashboard report zero production at
   * 02:39 IST while passing all afternoon.
   *
   * AWS RDS defaults its Postgres instances to UTC, so relying on the server's
   * own setting would not have saved this either.
   */
  timezone: env.APP_TIMEZONE,
  logging: env.NODE_ENV === 'development' ? console.log : false,
});

module.exports = { sequelize };
