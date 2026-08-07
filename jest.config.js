module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
  // Each test file calls sequelize.sync({ force: true }) against the same shared
  // test database in its own beforeAll — running files in parallel workers lets
  // one file's DROP/CREATE race another file's in-flight queries. Force serial
  // execution instead of adding cross-file DB coordination for a handful of tests.
  maxWorkers: 1,
};
