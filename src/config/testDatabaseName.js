/**
 * The one place that decides which database the test run destroys.
 *
 * This was computed independently in three places — the Sequelize connection,
 * the sequelize-cli config and the Jest globalSetup — and two of them disagreed
 * about the fallback. globalSetup fell back to `<DB_NAME>_test` while
 * sequelize-cli fell back to bare `DB_NAME`, so with DB_NAME_TEST unset the
 * suite would drop and rebuild the schema of one database and then run the
 * migrations against the *development* one.
 *
 * Deriving it once removes the possibility of that drift. It also never returns
 * DB_NAME itself: the test run opens with DROP SCHEMA public CASCADE, and the
 * development database has already been wiped once that way.
 */
const resolveTestDatabase = (env = process.env) => {
  const configured = env.DB_NAME_TEST;
  const fallback = `${env.DB_NAME}_test`;

  if (configured && configured === env.DB_NAME) {
    throw new Error(
      `DB_NAME_TEST is set to "${configured}", which is the same database as DB_NAME. ` +
        'The test harness drops the schema it connects to — point DB_NAME_TEST at a ' +
        'dedicated database, or unset it to use the default of ' +
        `"${fallback}".`
    );
  }

  return configured || fallback;
};

module.exports = { resolveTestDatabase };
