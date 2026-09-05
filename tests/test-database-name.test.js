const { resolveTestDatabase } = require('../src/config/testDatabaseName');

/**
 * The test run opens with DROP SCHEMA public CASCADE, so the only thing
 * standing between the suite and the development data is which name this
 * returns. It is asserted rather than assumed because the name used to be
 * computed in three places and two of them disagreed: globalSetup fell back to
 * "<DB_NAME>_test" while the sequelize-cli config fell back to bare DB_NAME, so
 * unsetting DB_NAME_TEST pointed db:migrate at the development database.
 */
describe('resolveTestDatabase', () => {
  it('defaults to a sibling of the development database, never the database itself', () => {
    expect(resolveTestDatabase({ DB_NAME: 'test-db' })).toBe('test-db_test');
  });

  it('honours an explicit override', () => {
    expect(resolveTestDatabase({ DB_NAME: 'test-db', DB_NAME_TEST: 'erp_ci' })).toBe('erp_ci');
  });

  it('refuses an override that names the development database', () => {
    expect(() => resolveTestDatabase({ DB_NAME: 'test-db', DB_NAME_TEST: 'test-db' }))
      .toThrow(/same database as DB_NAME/);
  });

  it('is the same name the sequelize-cli test config migrates', () => {
    // Both must agree, or the suite rebuilds one database and migrates another.
    const config = require('../src/config/sequelize-cli.config');
    expect(config.test.database).toBe(resolveTestDatabase());
    expect(config.test.database).not.toBe(config.development.database);
  });
});
