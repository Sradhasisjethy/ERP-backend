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
  logging: env.NODE_ENV === 'development' ? console.log : false,
});

module.exports = { sequelize };
