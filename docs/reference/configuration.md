# Configuration reference

`HOST` is fixed to loopback and defaults to `127.0.0.1`. `PORT` defaults to `4110`.

The application requires a valid `STORAGE_DATABASE_URL` at startup. It must use the runtime login role `wiki_arcana_runtime`. The PostgreSQL pool opens connections lazily, so a valid URL is required during configuration parsing, while the database connection is first opened when a storage operation runs. `/health` does not probe PostgreSQL.

Offline migrations use `STORAGE_ADMIN_DATABASE_URL` with a separate administrative role. `scripts/migrate.sh` accepts the production database name `wiki_arcana` only when `WIKI_VERIFIED_BACKUP_EVIDENCE` is non-empty. The script checks only that the marker is present; backup creation and restore verification must be completed and evidenced separately before a production migration. `DATABASE_URL` is not an application or migration setting. Database integration tests use `TEST_REGISTRY_DATABASE_URL` for the registry test and `TEST_STORAGE_DATABASE_URL` / `TEST_STORAGE_ADMIN_DATABASE_URL` for storage tests.

OIDC and downstream service URLs are environment-supplied. Secrets belong in the runtime secret store, never in repository files.

