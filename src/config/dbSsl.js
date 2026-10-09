const fs = require('fs');

/**
 * pg's `ssl` option from DB_SSL / DB_SSL_REJECT_UNAUTHORIZED / DB_SSL_CA_FILE.
 *
 * Shared by the app connection and sequelize-cli, which reads the environment
 * directly rather than through env.js. Returns `{}` when DB_SSL is not "true",
 * leaving the connection exactly as it was.
 */
const dbSslOptions = (source = process.env) => {
  if (source.DB_SSL !== 'true') return {};
  const ssl = { rejectUnauthorized: source.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
  if (source.DB_SSL_CA_FILE) ssl.ca = fs.readFileSync(source.DB_SSL_CA_FILE, 'utf8');
  return { ssl };
};

module.exports = { dbSslOptions };
