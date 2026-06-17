#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cd "${SCRIPT_DIR}"

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    echo "No .env found. Creating one from .env.example..."
    cp .env.example .env
    echo "Created ${SCRIPT_DIR}/.env"
    echo "Edit it if you need custom paths, passwords, or ports."
  else
    echo "Missing .env and .env.example in ${SCRIPT_DIR}"
    exit 1
  fi
fi

mkdir -p /mnt/user/appdata/portos/data
mkdir -p /mnt/user/appdata/portos/postgres
mkdir -p /mnt/user/appdata/portos/workspace

echo "Starting PortOS on Unraid..."
echo "Repo: ${REPO_ROOT}"
echo "Compose: ${SCRIPT_DIR}/docker-compose.yml"

docker compose up -d --build

echo ""
echo "PortOS should be available at:"
echo "  http://tower:5555"
echo "  http://<your-unraid-tailscale-name>:5555"
echo ""
echo "Logs:"
echo "  cd ${SCRIPT_DIR}"
echo "  docker compose logs -f portos"