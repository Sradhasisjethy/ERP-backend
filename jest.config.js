module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // helpers/ holds shared setup, not specs.
  testPathIgnorePatterns: ['/node_modules/', '/tests/helpers/'],
  // Builds the test database from the migrations once per run, so every test
  // exercises the same schema production gets rather than a weaker one built
  // from the models by sync(). See tests/helpers/db.js for the full reasoning.
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  // Generous because each file's beforeAll truncates ~70 tables and then seeds a
  // realistic scenario. At 15s those hooks intermittently timed out once the
  // suite grew past ~20 files — failures that moved between files run to run and
  // never reproduced in isolation, which is the signature of a hook running out
  // of time under load rather than a bug.
  testTimeout: 60000,
  // Every test file resets the same shared test database in its own beforeAll —
  // running files in parallel workers lets one file's TRUNCATE race another
  // file's in-flight queries. Force serial execution instead of adding
  // cross-file DB coordination for a handful of tests.
  maxWorkers: 1,
};
