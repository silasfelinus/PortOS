# Networked PostgreSQL for PortOS

PortOS can use a PostgreSQL server hosted on another machine, such as an Unraid box reachable over Tailscale.

## Recommended container

Use a PostgreSQL image that already includes pgvector. The PortOS local Docker Compose stack uses:

```txt
pgvector/pgvector:pg17
```

Plain `postgres` works for basic PostgreSQL, but PortOS needs the `vector` extension for vector search, so pgvector support matters.

## Unraid container settings

In Unraid Community Apps, prefer a pgvector PostgreSQL template if one is available. If you only see generic PostgreSQL templates, either use a template that lets you override the repository/image to `pgvector/pgvector:pg17`, or create the container manually from Docker.

Suggested settings:

```txt
Name: portos-postgres
Repository/Image: pgvector/pgvector:pg17
Network type: bridge
Host port: 5432
Container port: 5432
POSTGRES_DB: portos
POSTGRES_USER: portos
POSTGRES_PASSWORD: choose-a-real-password
PGDATA: /var/lib/postgresql/data
Appdata path: /mnt/user/appdata/portos-postgres/data -> /var/lib/postgresql/data
Restart policy: unless-stopped
```

Do not expose this container to the public internet. Use Tailscale/MagicDNS or your LAN only.

## PortOS `.env`

On the PortOS machine:

```env
PGMODE=network
PGHOST=ferngrotto
PGPORT=5432
PGDATABASE=portos
PGUSER=portos
PGPASSWORD=choose-a-real-password
```

Use the full MagicDNS name if the short name does not resolve:

```env
PGHOST=ferngrotto.foxhound-chicken.ts.net
```

Then run:

```bash
npm run setup:db
```

If the database is reachable but empty, setup will offer to apply `server/scripts/init-db.sql`.

## Quick checks

```bash
psql -h ferngrotto -p 5432 -U portos -d portos -c "SELECT 1;"
psql -h ferngrotto -p 5432 -U portos -d portos -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

If `CREATE EXTENSION vector` fails because the extension is missing, switch the Unraid container image to pgvector instead of plain postgres.
