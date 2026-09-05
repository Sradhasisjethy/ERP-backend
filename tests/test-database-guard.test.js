const path = require('path');

/**
 * The guard that stands between the suite and the development database.
 *
 * tests/helpers/db.js truncates every table in whatever src/config/database.js
 * connected to, and that module chooses its database from NODE_ENV. Jest sets
 * NODE_ENV to 'test' only when it is not already set, so an exported NODE_ENV
 * silently repoints the connection at DB_NAME while globalSetup still rebuilds
 * the _test database. The suite would truncate ~70 tables of live data and
 * pass.
 */
describe('test database guard', () => {
  const helperPath = path.resolve(__dirname, 'helpers/db.js');
  const configPath = path.resolve(__dirname, '../src/config/database.js');

  const loadWith = (databaseName) => {
    jest.resetModules();
    jest.doMock(configPath, () => ({
      sequelize: { getDatabaseName: () => databaseName, query: jest.fn() },
    }));
    return require(helperPath);
  };

  afterEach(() => {
    jest.dontMock(configPath);
    jest.resetModules();
  });

  it('passes when connected to the resolved test database', () => {
    const { resolveTestDatabase } = require('../src/config/testDatabaseName');
    const { assertTestDatabase } = loadWith(resolveTestDatabase());
    expect(() => assertTestDatabase()).not.toThrow();
  });

  it('refuses when the connection points at the development database', () => {
    const { assertTestDatabase } = loadWith(process.env.DB_NAME);
    expect(() => assertTestDatabase()).toThrow(/Refusing to wipe/);
  });

  it('guards the truncate, not just the schema drop', async () => {
    const { resetDatabase } = loadWith(process.env.DB_NAME);
    // The per-file reset is the one that runs ~47 times a suite.
    await expect(resetDatabase()).rejects.toThrow(/Refusing to wipe/);
  });

  it('guards the schema drop', async () => {
    const { dropSchema } = loadWith(process.env.DB_NAME);
    await expect(dropSchema()).rejects.toThrow(/Refusing to wipe/);
  });
});
