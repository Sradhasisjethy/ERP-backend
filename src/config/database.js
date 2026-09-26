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

  /**
   * Left unset, Sequelize allows five connections per process. That is five
   * database operations in flight, full stop: a sixth request waits on
   * `acquire` and fails after a minute. Every write here holds a connection
   * for its whole transaction (28–71 round trips for a sales document), so
   * five concurrent writers was the entire capacity of the application.
   *
   * Twenty-five is sized for one process against a Postgres with
   * max_connections = 100: two processes and the migrations still fit. Raise
   * max_connections, or put PgBouncer in front, before running more instances.
   * The scalability audit (docs/scalability-audit.md, §5) has the arithmetic.
   */
  pool: {
    max: 25,
    min: 2,
    // Fail fast rather than queue for a minute: a request that cannot get a
    // connection in fifteen seconds is better told so than left hanging.
    acquire: 15000,
    idle: 10000,
  },

  /**
   * Two server-side timeouts the database itself does not set (both were 0).
   *
   * `statement_timeout` stops one runaway query from holding a connection
   * indefinitely. `idle_in_transaction_session_timeout` reclaims a connection
   * whose transaction was opened and then abandoned — which is exactly what a
   * process blocked by an in-request export produces. Both are per session,
   * carried on this connection, so they travel with the application rather
   * than depending on how the server is configured.
   *
   * Thirty seconds is generous for any single statement here; the longest
   * legitimate ones are the report exports at their 10,000-row cap.
   */
  dialectOptions: {
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 60000,
  },
});

module.exports = { sequelize };
