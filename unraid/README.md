# PortOS on Unraid

This profile runs PortOS as an Unraid-friendly Docker Compose stack.

It creates:

- `portos` app container
- `portos-db` PostgreSQL + pgvector container
- persistent app data under `/mnt/user/appdata/portos/data`
- persistent database data under `/mnt/user/appdata/portos/postgres`
- a workspace mount under `/mnt/user/appdata/portos/workspace`

## Setup

```bash
cd /mnt/user/appdata
git clone https://github.com/silasfelinus/PortOS.git portos-src
cd portos-src/unraid
cp .env.example .env
nano .env
docker compose up -d --build