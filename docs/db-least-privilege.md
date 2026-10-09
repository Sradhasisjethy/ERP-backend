# Database roles: least privilege for the running app

Tenant isolation in this application is enforced in code (the model hooks in
`src/core/BaseModel.js` and the plant checks in `src/core/salesScope.js`).
Nothing in the database backs it up today, and the app and the migrations
connect with the same credentials — so the role the web process uses can also
create, alter and drop tables. A query bug, or an injection, would arrive with
schema rights.

This runbook splits that into two roles. It changes nothing by itself: run it
on the database server, then set the environment variables below.

## 1. Create the roles

Run as a superuser (or the current owner of the database). Replace the
placeholders; generate passwords with `openssl rand -base64 32` and store them
only in Render's environment, never in this repository.

```sql
-- Owns the schema and runs migrations.
CREATE ROLE erp_migrator LOGIN PASSWORD '<generate>';
-- What the web process uses: data only.
CREATE ROLE erp_app LOGIN PASSWORD '<generate>';

-- Hand the existing objects to the migrator (run in the application database).
REASSIGN OWNED BY <current_owner_role> TO erp_migrator;   -- only if the current owner is not a superuser you still need
ALTER SCHEMA public OWNER TO erp_migrator;

-- The app may connect and read/write rows, nothing more.
GRANT CONNECT ON DATABASE <db_name> TO erp_app;
GRANT USAGE ON SCHEMA public TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
REVOKE CREATE ON SCHEMA public FROM erp_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Tables and sequences the migrator creates later get the same app grants.
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE erp_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
```

Notes:
- Some migrations use extensions (`pg_trgm`). Create extensions as a superuser
  once; neither role needs `CREATE EXTENSION` afterwards.
- `SequelizeMeta` (the migration ledger) is owned by the migrator; the app reads
  it at boot to warn about pending migrations, which the SELECT grant covers.
- The nightly job takes an advisory lock (`pg_try_advisory_lock`); no grant is
  needed for that.

## 2. Point the app and the migrations at them

| Variable | Used by | Value |
|---|---|---|
| `DB_USER` / `DB_PASSWORD` | the web process | `erp_app` |
| `DB_MIGRATOR_USER` / `DB_MIGRATOR_PASSWORD` | `npm run migrate` (`src/config/sequelize-cli.config.js`) | `erp_migrator` |

With `DB_MIGRATOR_USER` unset, migrations use `DB_USER` as before.

## 3. Verify

```sql
-- As erp_app: must fail with "permission denied for schema public".
CREATE TABLE should_fail (id int);
-- As erp_app: must succeed (reads a row count, changes nothing).
SELECT count(*) FROM tenants;
```

Also check that no role you did not intend is a superuser:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolcanlogin;
```

## 4. Further hardening (not done here)

- **Row-level security on `tenantId`.** Postgres RLS policies keyed on a
  per-transaction setting (`SET LOCAL app.tenant_id = ...`) would make a missed
  tenant filter return nothing instead of another company's rows. It needs the
  setting applied on every pooled connection inside each request's transaction
  and a policy per table — a project of its own, tracked as a recommendation.
- **Network.** Keep port 5432 closed to everything except the app hosts.
