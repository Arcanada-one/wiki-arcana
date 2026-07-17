# Configuration reference

`HOST` is fixed to loopback and defaults to `127.0.0.1`. `PORT` defaults to `4100`. `DATABASE_URL` is mandatory for migrations. Production migration additionally requires verified backup evidence.

OIDC and downstream service URLs are environment-supplied. Secrets belong in the runtime secret store, never in repository files.

