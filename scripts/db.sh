#!/usr/bin/env bash
#
# PortOS Database Manager
#
# Manage PostgreSQL via Docker or native (system) installation.
# Native mode reuses an existing system PostgreSQL (e.g., Homebrew) on port 5432
# rather than running a separate instance. Docker mode runs a container on port 5561.
#
# Usage:
#   scripts/db.sh <command>
#
# Commands:
#   status       Show current database status
#   start        Start the database (auto-detects mode)
#   stop         Stop the database
#   fix          Fix common issues (stale pid files, etc.)
#   setup-native Install and configure native PostgreSQL via Homebrew
#   use-docker   Switch to Docker mode
#   use-native   Switch to native mode
#   migrate      Export from current mode, import to the other
#   export       Export database to a SQL dump file
#   import       Import a SQL dump file into the database
#   logs         Show database logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PGUSER="${PGUSER:-portos}"
PGDATABASE="${PGDATABASE:-portos}"
PGPASSWORD="${PGPASSWORD:-portos}"
PGHOST="${PGHOST:-localhost}"
DUMP_DIR="$ROOT_DIR/data/db-dumps"
ENV_FILE="$ROOT_DIR/.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${BLUE}🗄️  $1${NC}"; }

# Portable in-place sed helper (works with BSD and GNU sed)
inplace_sed() {
  local script="$1"
  local file="$2"
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  sed "$script" "$file" >"$tmp"
  mv "$tmp" "$file"
}

# True when running under Git Bash / MSYS2 / Cygwin on Windows
_is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Detect current mode from .env or default to docker
get_mode() {
  if [ -f "$ENV_FILE" ]; then
    local mode
    mode=$(grep -E '^PGMODE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)
    echo "${mode:-docker}"
  else
    echo "docker"
  fi
}

# Derive port from mode: native=5432 (system pg), docker=5561 (container)
get_port() {
  if [ -n "${PGPORT:-}" ]; then
    echo "$PGPORT"
  elif [ "$(get_mode)" = "native" ]; then
    echo "5432"
  else
    echo "5561"
  fi
}

PGPORT=$(get_port)

# Set mode in .env
set_mode() {
  local mode="$1"
  if [ -f "$ENV_FILE" ]; then
    if grep -q '^PGMODE=' "$ENV_FILE"; then
      inplace_sed "s/^PGMODE=.*/PGMODE=$mode/" "$ENV_FILE"
    else
      echo "PGMODE=$mode" >> "$ENV_FILE"
    fi
  else
    echo "PGMODE=$mode" > "$ENV_FILE"
  fi
  # Update PGPORT to match mode
  PGPORT=$([ "$mode" = "native" ] && echo "5432" || echo "5561")
  log "Mode set to: $mode (port $PGPORT)"
}

# Check if Docker PostgreSQL is running
docker_running() {
  docker ps --filter name=portos-db --format '{{.Status}}' 2>/dev/null | grep -qi "up"
}

# Verify Docker and Compose plugin are available
require_docker_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker not installed"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not running. Start Docker Desktop or the Docker service."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose plugin not available. Install it: https://docs.docker.com/compose/install/"
    exit 1
  fi
}

# Check if native PostgreSQL is accepting connections on the expected port
native_running() {
  PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1
}

# Auto-detect Homebrew PostgreSQL 17 on macOS and add to PATH
# Check both arm64 (/opt/homebrew) and Intel (/usr/local) prefixes
if [ "$(uname)" = "Darwin" ]; then
  for _prefix in /opt/homebrew/opt/postgresql@17 /usr/local/opt/postgresql@17; do
    if [ -x "$_prefix/bin/psql" ]; then
      export PATH="$_prefix/bin:$PATH"
      break
    fi
  done
fi

# Auto-detect PostgreSQL on Windows (Git Bash / MINGW) and add to PATH
if _is_windows; then
  for _ver in 17 16 15 14; do
    _pg_win="/c/Program Files/PostgreSQL/$_ver/bin"
    if [ -x "$_pg_win/psql.exe" ]; then
      export PATH="$_pg_win:$PATH"
      break
    fi
  done
fi

# Check if native PostgreSQL is installed
has_native_pg() {
  command -v psql >/dev/null 2>&1
}

# Find the systemctl service name for PostgreSQL on this system
find_pg_service() {
  for svc in "postgresql@17-main" "postgresql-17" "postgresql"; do
    if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${svc}\\.service"; then
      echo "$svc"
      return 0
    fi
  done
  echo "postgresql"
}

# Find the Windows service name for PostgreSQL (e.g. postgresql-x64-17)
_find_windows_pg_service() {
  for _svc in "postgresql-x64-17" "postgresql-x64-16" "postgresql-x64-15" "postgresql-x64-14" "postgresql"; do
    if sc.exe query "$_svc" 2>/dev/null | grep -qi "SERVICE_NAME"; then
      echo "$_svc"
      return 0
    fi
  done
  echo ""
}

# Add the PGDG APT repository (idempotent — skips if already configured)
_add_pgdg_apt_repo() {
  if [ -f /etc/apt/sources.list.d/pgdg.list ] || [ -f /usr/share/keyrings/postgresql.gpg ]; then
    return 0
  fi
  info "Adding PGDG APT repository..."
  sudo apt-get install -y curl gnupg lsb-release >/dev/null 2>&1 || true
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | sudo gpg --dearmor -o /usr/share/keyrings/postgresql.gpg 2>/dev/null
  local codename
  if command -v lsb_release >/dev/null 2>&1; then
    codename=$(lsb_release -cs)
  else
    codename=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-$ID}")
  fi
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo apt-get update -q
}

# Full native setup for Debian/Ubuntu systems
_setup_native_debian() {
  local pg_version=17

  if command -v psql >/dev/null 2>&1; then
    local detected_ver
    detected_ver=$(psql --version 2>/dev/null | sed 's/.*PostgreSQL \([0-9]*\).*/\1/' || echo "")
    [ -n "$detected_ver" ] && pg_version="$detected_ver"
    info "PostgreSQL $pg_version detected"

    # Check if pgvector is loadable; install it if missing
    if ! sudo -u postgres psql -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1; then
      info "Installing pgvector for PostgreSQL $pg_version..."
      _add_pgdg_apt_repo
      sudo apt-get install -y "postgresql-${pg_version}-pgvector" || {
        err "Could not install postgresql-${pg_version}-pgvector — install it manually then re-run."
        exit 1
      }
    fi
  else
    info "Installing PostgreSQL $pg_version and pgvector..."
    _add_pgdg_apt_repo
    sudo apt-get install -y "postgresql-${pg_version}" "postgresql-${pg_version}-pgvector" || {
      err "PostgreSQL install failed. Try: sudo apt-get install postgresql-17 postgresql-17-pgvector"
      exit 1
    }
  fi

  # Ensure the service is running
  local pg_svc
  pg_svc=$(find_pg_service)
  if ! pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then
    info "Starting PostgreSQL ($pg_svc)..."
    sudo systemctl enable "$pg_svc" 2>/dev/null || true
    sudo systemctl start "$pg_svc" 2>/dev/null || true
    for i in $(seq 1 15); do
      if pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then break; fi
      sleep 1
    done
    if ! pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then
      err "PostgreSQL did not start. Check: sudo systemctl status $pg_svc"
      exit 1
    fi
  fi
  log "PostgreSQL ready on port 5432"
  PGPORT=5432

  # Create the portos role if missing
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" 2>/dev/null | grep -q 1; then
    info "Creating database user: $PGUSER"
    sudo -u postgres psql \
      -c "CREATE ROLE $PGUSER WITH LOGIN PASSWORD '$PGPASSWORD' CREATEDB SUPERUSER;"
    log "User $PGUSER created"
  else
    log "User $PGUSER already exists"
    sudo -u postgres psql \
      -c "ALTER USER $PGUSER WITH PASSWORD '$PGPASSWORD' SUPERUSER;" 2>/dev/null || true
  fi

  # Create the portos database if missing
  if ! sudo -u postgres psql -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
    info "Creating database: $PGDATABASE"
    sudo -u postgres createdb "$PGDATABASE" -O "$PGUSER"
    log "Database $PGDATABASE created"
  else
    log "Database $PGDATABASE already exists"
  fi

  # Enable extensions (as postgres superuser) then apply schema (as portos via TCP)
  info "Applying schema..."
  sudo -u postgres psql -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 || true
  sudo -u postgres psql -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null 2>&1 || true
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p 5432 -U "$PGUSER" -d "$PGDATABASE" \
    -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  set_mode native

  echo ""
  log "Native PostgreSQL is ready!"
  info "Database: $PGDATABASE (user: $PGUSER, port: 5432)"
  info "To migrate data from Docker: scripts/db.sh migrate"
}

# Full native setup for Windows (Git Bash / MINGW)
# Uses the 'postgres' superuser because Windows installs don't use OS peer auth.
# Set PGPASSWORD_SUPERUSER in your environment to override the superuser password
# (defaults to empty then 'postgres' for common dev installs).
_setup_native_windows() {
  info "Setting up native PostgreSQL on Windows..."

  if ! command -v psql >/dev/null 2>&1; then
    err "PostgreSQL not found. Install from https://www.postgresql.org/download/windows/"
    echo "  After installing, re-run: scripts/db.sh setup-native  (from Git Bash)"
    exit 1
  fi

  # Start the service if not already listening
  if ! pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then
    local pg_svc
    pg_svc=$(_find_windows_pg_service)
    if [ -n "$pg_svc" ]; then
      info "Starting PostgreSQL service ($pg_svc)..."
      net.exe start "$pg_svc" 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then break; fi
        sleep 1
      done
    fi
    if ! pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then
      err "PostgreSQL is not running. Start it via Services (services.msc) or run as Administrator:"
      echo "  net start postgresql-x64-17"
      exit 1
    fi
  fi
  log "PostgreSQL ready on port 5432"
  PGPORT=5432

  # Resolve the postgres superuser password.
  # Windows installs use a password set during installation; peer auth is not available.
  local pg_admin_pass="${PGPASSWORD_SUPERUSER:-}"
  local admin_ok=0
  if PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
       -c "SELECT 1" >/dev/null 2>&1; then
    admin_ok=1
  elif [ -z "$pg_admin_pass" ] && PGPASSWORD="postgres" psql -h "$PGHOST" -p 5432 \
       -U postgres -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    pg_admin_pass="postgres"
    admin_ok=1
  fi
  if [ "$admin_ok" -ne 1 ]; then
    err "Cannot connect as the PostgreSQL superuser (postgres)."
    echo "  Set the password via: export PGPASSWORD_SUPERUSER=<your-postgres-password>"
    echo "  Then re-run: scripts/db.sh setup-native"
    exit 1
  fi

  # pgvector — warn if missing (Stack Builder or manual install required on Windows)
  if ! PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
       -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1; then
    warn "pgvector not available — AI memory features need it."
    warn "Install via Stack Builder (Start menu > PostgreSQL > Application Stack Builder)"
    warn "or download from https://github.com/pgvector/pgvector/releases"
  fi

  # Create portos role if missing
  if ! PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
       -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" 2>/dev/null | grep -q 1; then
    info "Creating database user: $PGUSER"
    PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
      -c "CREATE ROLE $PGUSER WITH LOGIN PASSWORD '$PGPASSWORD' CREATEDB SUPERUSER;"
    log "User $PGUSER created"
  else
    log "User $PGUSER already exists"
    PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
      -c "ALTER USER $PGUSER WITH PASSWORD '$PGPASSWORD' SUPERUSER;" 2>/dev/null || true
  fi

  # Create portos database if missing
  if ! PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres -lqt \
       2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
    info "Creating database: $PGDATABASE"
    PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d postgres \
      -c "CREATE DATABASE $PGDATABASE OWNER $PGUSER;"
    log "Database $PGDATABASE created"
  else
    log "Database $PGDATABASE already exists"
  fi

  # Enable extensions (as postgres superuser) then apply schema (as portos via TCP)
  info "Applying schema..."
  PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d "$PGDATABASE" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
  PGPASSWORD="$pg_admin_pass" psql -h "$PGHOST" -p 5432 -U postgres -d "$PGDATABASE" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p 5432 -U "$PGUSER" -d "$PGDATABASE" \
    -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  set_mode native

  echo ""
  log "Native PostgreSQL is ready!"
  info "Database: $PGDATABASE (user: $PGUSER, port: 5432)"
  info "To migrate data from Docker: scripts/db.sh migrate"
}

# Detect an already-running system PostgreSQL and its port
detect_system_pg() {
  # Check standard port 5432 first
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "5432"
    return 0
  fi
  # Check if pg_ctl reports a running server
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    # Try Homebrew default data dir
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
      if [ ! -d "$datadir" ]; then
        datadir="$(brew --prefix)/var/postgres"
      fi
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ] && pg_ctl -D "$datadir" status >/dev/null 2>&1; then
      # Parse port from postgresql.conf
      local port
      port=$(grep -E '^port\s*=' "$datadir/postgresql.conf" 2>/dev/null | sed 's/.*=\s*//' | tr -d '[:space:]' || echo "5432")
      echo "${port:-5432}"
      return 0
    fi
  fi
  return 1
}

# Status command
cmd_status() {
  local mode
  mode=$(get_mode)
  info "Current mode: $mode"
  info "Port: $PGPORT"

  echo ""
  echo "Docker:"
  if ! command -v docker >/dev/null 2>&1; then
    warn "  Docker not installed"
  elif ! docker info >/dev/null 2>&1; then
    warn "  Docker daemon is not running"
  elif docker ps --filter name=portos-db --format '{{.Status}}' 2>/dev/null | grep -qi "up"; then
    log "  Container portos-db is running"
  else
    warn "  Container portos-db is not running"
  fi

  echo ""
  echo "Native:"
  if has_native_pg; then
    local sys_port
    if sys_port=$(detect_system_pg); then
      log "  System PostgreSQL is running on port $sys_port"
      # Check if portos database exists
      if PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$sys_port" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1" >/dev/null 2>&1; then
        log "  PortOS database exists"
      else
        warn "  PortOS database/user not configured (run: scripts/db.sh setup-native)"
      fi
    else
      warn "  Native PostgreSQL installed but not running"
    fi
  else
    warn "  Native PostgreSQL not installed"
  fi

  echo ""
  echo "Connectivity:"
  if run_psql -c "SELECT 1" >/dev/null 2>&1; then
    log "  Database is accepting connections on port $PGPORT"
    local count
    count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "N/A")
    info "  Memories table has $count rows"
  else
    warn "  Cannot connect to database on port $PGPORT"
  fi
}

# Start command
cmd_start() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "native" ]; then
    start_native
  else
    start_docker
  fi
}

start_docker() {
  info "Starting Docker PostgreSQL..."

  require_docker_compose

  if docker_running; then
    log "Already running"
    return
  fi

  cd "$ROOT_DIR"
  docker compose up -d db
  info "Waiting for PostgreSQL..."

  for i in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U "$PGUSER" >/dev/null 2>&1; then
      log "PostgreSQL ready on port $PGPORT"
      return
    fi
    sleep 1
  done

  # Check for stale pid issue (one auto-fix attempt only)
  if [ "${_DB_FIX_ATTEMPTED:-}" != "1" ] && docker logs portos-db --tail 5 2>&1 | grep -q "bogus data in lock file"; then
    warn "Stale postmaster.pid detected — running fix..."
    export _DB_FIX_ATTEMPTED=1
    cmd_fix
    start_docker
    return
  fi

  err "PostgreSQL did not become ready in 30s"
  echo "  Check logs: docker compose logs db"
  exit 1
}

start_native() {
  info "Starting native PostgreSQL..."

  if ! has_native_pg; then
    err "Native PostgreSQL not installed. Run: scripts/db.sh setup-native"
    exit 1
  fi

  # Check if system PostgreSQL is already running and accepting connections
  if PGPASSWORD="$PGPASSWORD" pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
    log "Native PostgreSQL already running on port $PGPORT"
    return
  fi

  # Try to start via Homebrew services (macOS)
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    if brew services list 2>/dev/null | grep -q "postgresql@17"; then
      info "Starting PostgreSQL via Homebrew services..."
      brew services start postgresql@17 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
  fi

  # Try pg_ctl with Homebrew data directory
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
      if [ ! -d "$datadir" ]; then
        datadir="$(brew --prefix)/var/postgres"
      fi
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ]; then
      pg_ctl -D "$datadir" -l "$datadir/server.log" start 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
  fi

  # Windows: net start
  if _is_windows; then
    local pg_svc
    pg_svc=$(_find_windows_pg_service)
    if [ -n "$pg_svc" ]; then
      info "Starting PostgreSQL service ($pg_svc)..."
      net.exe start "$pg_svc" 2>/dev/null || true
      for i in $(seq 1 15); do
        if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
          log "Native PostgreSQL ready on port $PGPORT"
          return
        fi
        sleep 1
      done
    fi
    err "Could not start PostgreSQL. Run as Administrator or open Services (services.msc)."
    exit 1
  fi

  # Linux: try systemctl
  if [ "$(uname)" != "Darwin" ] && command -v systemctl >/dev/null 2>&1; then
    local pg_svc
    pg_svc=$(find_pg_service)
    info "Starting PostgreSQL via systemctl ($pg_svc)..."
    sudo systemctl start "$pg_svc" 2>/dev/null || true
    for i in $(seq 1 15); do
      if pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
        log "Native PostgreSQL ready on port $PGPORT"
        return
      fi
      sleep 1
    done
  fi

  if [ "$(uname)" = "Darwin" ]; then
    err "Could not start PostgreSQL. Try: brew services start postgresql@17"
  else
    err "Could not start PostgreSQL. Try: sudo systemctl start postgresql"
  fi
  exit 1
}

# Stop command
cmd_stop() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "native" ]; then
    stop_native
  else
    stop_docker
  fi
}

stop_docker() {
  info "Stopping Docker PostgreSQL..."
  require_docker_compose
  cd "$ROOT_DIR"
  docker compose stop db 2>/dev/null || true
  log "Stopped"
}

stop_native() {
  info "Stopping native PostgreSQL..."
  # macOS: Homebrew services
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services stop postgresql@17 2>/dev/null || true
    log "Stopped"
    return
  fi
  # Windows: net stop
  if _is_windows; then
    local pg_svc
    pg_svc=$(_find_windows_pg_service)
    if [ -n "$pg_svc" ]; then
      net.exe stop "$pg_svc" 2>/dev/null || true
    fi
    log "Stopped"
    return
  fi
  # Linux: systemctl
  if [ "$(uname)" != "Darwin" ] && command -v systemctl >/dev/null 2>&1; then
    local pg_svc
    pg_svc=$(find_pg_service)
    sudo systemctl stop "$pg_svc" 2>/dev/null || true
    log "Stopped"
    return
  fi
  # Fallback: pg_ctl (macOS non-Homebrew)
  if command -v pg_ctl >/dev/null 2>&1; then
    local datadir=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      datadir="$(brew --prefix)/var/postgresql@17"
    fi
    if [ -n "$datadir" ] && [ -d "$datadir" ]; then
      pg_ctl -D "$datadir" stop -m fast 2>/dev/null || true
    fi
  fi
  log "Stopped"
}

# Fix command — resolve common issues
cmd_fix() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "docker" ]; then
    fix_docker
  else
    fix_native
  fi
}

fix_docker() {
  info "Fixing Docker PostgreSQL..."

  require_docker_compose

  cd "$ROOT_DIR"

  # Determine the actual data volume used by the portos-db container, if it exists
  local data_volume=""
  data_volume=$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}' portos-db 2>/dev/null || echo "")

  # Stop and remove container
  docker compose stop db 2>/dev/null || true
  docker rm -f portos-db 2>/dev/null || true

  # Remove stale postmaster.pid from the volume
  if [ -n "$data_volume" ]; then
    docker run --rm -v "${data_volume}:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null || true
  else
    # Fallback: derive volume name from compose project name
    local project_name
    project_name=$(docker compose config --format json 2>/dev/null | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "portos")
    docker run --rm -v "${project_name}_portos-pgdata:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null ||
      docker run --rm -v "portos-pgdata:/data" alpine:3.20 rm -f /data/postmaster.pid 2>/dev/null || true
  fi

  log "Stale lock files cleaned"
  info "Run 'scripts/db.sh start' to restart"
}

fix_native() {
  info "Fixing native PostgreSQL..."
  # macOS: Homebrew services
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services restart postgresql@17 2>/dev/null || true
    log "PostgreSQL restarted via Homebrew"
    return
  fi
  # Windows: net stop + net start
  if _is_windows; then
    local pg_svc
    pg_svc=$(_find_windows_pg_service)
    if [ -n "$pg_svc" ]; then
      info "Restarting PostgreSQL service ($pg_svc)..."
      net.exe stop "$pg_svc" 2>/dev/null || true
      sleep 2
      net.exe start "$pg_svc" 2>/dev/null || true
      log "PostgreSQL restarted"
    else
      warn "No PostgreSQL Windows service found — check Services (services.msc)"
    fi
    return
  fi
  # Linux: systemctl
  if [ "$(uname)" != "Darwin" ] && command -v systemctl >/dev/null 2>&1; then
    local pg_svc
    pg_svc=$(find_pg_service)
    sudo systemctl restart "$pg_svc" 2>/dev/null || true
    log "PostgreSQL restarted via systemctl"
    return
  fi
  warn "Manual fix may be needed — check PostgreSQL logs"
}

# Setup native PostgreSQL — detects and reuses existing system installation
cmd_setup_native() {
  info "Setting up native PostgreSQL for PortOS..."

  # Windows (Git Bash / MINGW): use Windows service manager + postgres superuser
  if _is_windows; then
    _setup_native_windows
    return
  fi

  # Linux: Debian/Ubuntu — fully automated via apt + PGDG
  if [ "$(uname)" != "Darwin" ] && command -v apt-get >/dev/null 2>&1; then
    _setup_native_debian
    return
  fi

  # Linux: RHEL/Fedora — provide PGDG instructions (no automated install)
  if [ "$(uname)" != "Darwin" ] && { command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; }; then
    err "RHEL/Fedora: install PostgreSQL 17 + pgvector from PGDG, then re-run setup-native"
    echo ""
    echo "  sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
    echo "  sudo dnf -qy module disable postgresql"
    echo "  sudo dnf install -y postgresql17-server pgvector_17"
    echo "  sudo /usr/pgsql-17/bin/postgresql-17-setup initdb"
    echo "  sudo systemctl enable --now postgresql-17"
    echo "  scripts/db.sh setup-native"
    exit 1
  fi

  # Step 1: Ensure PostgreSQL is installed
  if [ "$(uname)" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      err "Homebrew not installed. Install from https://brew.sh"
      exit 1
    fi

    if ! brew list postgresql@17 >/dev/null 2>&1; then
      info "Installing PostgreSQL 17..."
      brew install postgresql@17
    else
      log "PostgreSQL 17 already installed"
    fi

    if ! brew list pgvector >/dev/null 2>&1; then
      info "Installing pgvector..."
      brew install pgvector
    else
      log "pgvector already installed"
    fi

    # Ensure pg17 binaries are on PATH
    PG_BIN="$(brew --prefix postgresql@17)/bin"
    export PATH="$PG_BIN:$PATH"
    info "Using PostgreSQL from: $PG_BIN"
  else
    if ! command -v psql >/dev/null 2>&1; then
      err "Please install PostgreSQL 17 and pgvector for your platform"
      exit 1
    fi
  fi

  # Step 2: Ensure PostgreSQL is running
  local pg_port=""
  if pg_port=$(detect_system_pg); then
    log "System PostgreSQL already running on port $pg_port"
  else
    info "Starting PostgreSQL..."
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      brew services start postgresql@17
      sleep 2
      if pg_port=$(detect_system_pg); then
        log "PostgreSQL started on port $pg_port"
      else
        err "PostgreSQL failed to start. Check: brew services list"
        exit 1
      fi
    else
      err "PostgreSQL is not running. Start it and try again."
      exit 1
    fi
  fi

  PGPORT="$pg_port"

  # Step 3: Create portos user if it doesn't exist
  # Connect as the current system user (default Homebrew superuser) to create the role
  local sys_user
  sys_user="$(whoami)"
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PGUSER'" 2>/dev/null | grep -q 1; then
    info "Creating database user: $PGUSER"
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres \
      -c "CREATE ROLE $PGUSER WITH LOGIN PASSWORD '$PGPASSWORD' CREATEDB SUPERUSER;"
    log "User $PGUSER created"
  else
    log "User $PGUSER already exists"
    # Ensure password and superuser are set correctly (superuser needed for extension management)
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres \
      -c "ALTER USER $PGUSER WITH PASSWORD '$PGPASSWORD' SUPERUSER;" 2>/dev/null || true
  fi

  # Step 4: Create portos database if it doesn't exist
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
    info "Creating database: $PGDATABASE"
    psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d postgres -c "CREATE DATABASE $PGDATABASE OWNER $PGUSER;"
    log "Database $PGDATABASE created"
  else
    log "Database $PGDATABASE already exists"
  fi

  # Step 5: Enable pgvector extension and apply schema
  info "Applying schema..."
  # pgvector extension requires superuser — create as system user, then run schema as portos
  psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
  psql -h "$PGHOST" -p "$PGPORT" -U "$sys_user" -d "$PGDATABASE" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>/dev/null || true
  PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 --single-transaction -f "$ROOT_DIR/server/scripts/init-db.sql"
  log "Schema applied"

  # Step 6: Switch mode to native
  set_mode native

  echo ""
  log "Native PostgreSQL is ready!"
  info "Using system PostgreSQL on port $PGPORT"
  info "Database: $PGDATABASE (user: $PGUSER)"
  info "To migrate data from Docker: scripts/db.sh migrate"
}

# Run psql command, using Docker exec in Docker mode if host psql is unavailable
run_psql() {
  local mode
  mode=$(get_mode)
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif [ "$mode" = "docker" ] && docker_running; then
    docker exec -e PGPASSWORD="$PGPASSWORD" portos-db psql -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "psql not found on host and Docker DB is not running"
    exit 1
  fi
}

# Run pg_dump, preferring Docker exec in Docker mode to avoid version mismatch
run_pg_dump() {
  local mode
  mode=$(get_mode)
  if [ "$mode" = "docker" ] && docker_running; then
    docker exec -e PGPASSWORD="$PGPASSWORD" portos-db pg_dump -U "$PGUSER" -d "$PGDATABASE" "$@"
  elif command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD" pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"
  else
    err "pg_dump not found on host and Docker DB is not running"
    exit 1
  fi
}

# Export database to SQL dump
cmd_export() {
  local label="${1:-$(date +%Y%m%d-%H%M%S)}"

  # Sanitize label to prevent path traversal
  if echo "$label" | grep -qE '[^A-Za-z0-9._-]'; then
    err "Invalid label: only alphanumeric, dots, hyphens, and underscores are allowed"
    exit 1
  fi

  mkdir -p "$DUMP_DIR"
  local dumpfile="$DUMP_DIR/portos-$label.sql"

  info "Exporting database to $dumpfile..." >&2

  # Dump to a temp file first to avoid leaving a partial/corrupt dump on failure
  local tmpfile
  tmpfile="$(mktemp "$DUMP_DIR/portos-export.XXXXXX")"
  run_pg_dump --no-owner --no-privileges --if-exists --clean > "$tmpfile"
  mv "$tmpfile" "$dumpfile"

  log "Exported to: $dumpfile" >&2
  echo "$dumpfile"
}

# Import SQL dump into database
cmd_import() {
  local dumpfile="$1"

  if [ ! -f "$dumpfile" ]; then
    err "Dump file not found: $dumpfile"
    exit 1
  fi

  info "Importing $dumpfile..."

  # Strip pg17-only features for compatibility with older psql versions:
  # - \restrict/\unrestrict (pg17 dump security tokens)
  # - SET transaction_timeout (pg17 config parameter)
  sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^SET transaction_timeout/d' "$dumpfile" | run_psql -v ON_ERROR_STOP=1 --single-transaction

  log "Import complete"
}

# Import a dump into a specific target using Docker's pg17 psql when available.
# This avoids version-mismatch issues when the host psql is older than the dump format.
import_to_target() {
  local dumpfile="$1"
  local target_port="$2"

  # Strip pg17-only features for compat with older psql
  local filtered
  filtered="$(sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^SET transaction_timeout/d' "$dumpfile")"

  # Prefer Docker's pg17 psql to avoid version mismatch with host psql
  if docker_running; then
    echo "$filtered" | docker exec -i -e PGPASSWORD="$PGPASSWORD" portos-db \
      psql -h host.docker.internal -p "$target_port" -U "$PGUSER" -d "$PGDATABASE" \
      -v ON_ERROR_STOP=1 --single-transaction
  else
    echo "$filtered" | PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$target_port" -U "$PGUSER" -d "$PGDATABASE" \
      -v ON_ERROR_STOP=1 --single-transaction
  fi
}

# Migrate data between Docker and native
cmd_migrate() {
  local current_mode
  current_mode=$(get_mode)
  local target_mode

  if [ "$current_mode" = "docker" ]; then
    target_mode="native"
  else
    target_mode="docker"
  fi

  info "Migrating data from $current_mode to $target_mode..."

  # Verify source is running
  if ! run_psql -c "SELECT 1" >/dev/null 2>&1; then
    err "Source database ($current_mode) is not running on port $PGPORT"
    echo "  Start it first: scripts/db.sh start"
    exit 1
  fi

  # Count source records
  local count
  count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")
  info "Source has $count memories"

  # Export from source
  local dumpfile
  dumpfile=$(cmd_export "migrate-$(date +%Y%m%d-%H%M%S)")

  # Determine target port
  local target_port
  target_port=$([ "$target_mode" = "native" ] && echo "5432" || echo "5561")

  # Ensure target is running (keep source running too — they use different ports)
  if [ "$target_mode" = "native" ]; then
    # Ensure native pg is up (don't stop Docker — we need its pg17 psql)
    if ! pg_isready -h "$PGHOST" -p "$target_port" >/dev/null 2>&1; then
      start_native
    fi
  else
    # Start Docker if not running
    if ! docker_running; then
      require_docker_compose
      cd "$ROOT_DIR"
      docker compose up -d db
      info "Waiting for Docker PostgreSQL..."
      for i in $(seq 1 30); do
        if docker compose exec -T db pg_isready -U "$PGUSER" >/dev/null 2>&1; then break; fi
        sleep 1
      done
    fi
  fi

  # Restore mode on failure or interruption
  _migrate_cleanup() {
    warn "Migration aborted — restoring mode to $current_mode"
    set_mode "$current_mode"
  }
  trap '_migrate_cleanup' ERR INT TERM

  # Import into target
  info "Importing into $target_mode (port $target_port)..."
  import_to_target "$dumpfile" "$target_port"

  # Switch mode to target
  set_mode "$target_mode"
  PGPORT=$(get_port)

  # Clear traps after successful import
  trap - ERR INT TERM

  # Stop the old source if desired (both can coexist, but stop to save resources)
  if [ "$current_mode" = "docker" ]; then
    info "Stopping Docker..."
    stop_docker
  fi

  # Verify
  local new_count
  new_count=$(run_psql -tAc "SELECT count(*) FROM memories" 2>/dev/null || echo "0")

  echo ""
  log "Migration complete!"
  info "Source ($current_mode): $count memories"
  info "Target ($target_mode): $new_count memories"
  info "Dump saved: $dumpfile"
}

# Use Docker mode
cmd_use_docker() {
  set_mode docker
  info "Switched to Docker mode (port 5561). Run 'scripts/db.sh start' to start."
}

# Use native mode
cmd_use_native() {
  if ! has_native_pg; then
    err "Native PostgreSQL not installed. Run: scripts/db.sh setup-native"
    exit 1
  fi
  # Verify system pg is reachable
  if ! pg_isready -h "$PGHOST" -p 5432 >/dev/null 2>&1; then
    warn "System PostgreSQL not running on port 5432"
    echo "  Start it: brew services start postgresql@17"
  fi
  # Best-effort stop of Docker DB container
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    (
      cd "$ROOT_DIR"
      docker compose stop db >/dev/null 2>&1 || true
    )
  fi
  set_mode native
  info "Switched to native mode (port 5432). Run 'scripts/db.sh start' to start."
}

# Show logs
cmd_logs() {
  local mode
  mode=$(get_mode)

  if [ "$mode" = "docker" ]; then
    require_docker_compose
    cd "$ROOT_DIR"
    docker compose logs -f db
  else
    # Homebrew pg logs
    local logfile=""
    if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      logfile="$(brew --prefix)/var/log/postgresql@17.log"
    fi
    if [ -n "$logfile" ] && [ -f "$logfile" ]; then
      tail -f "$logfile"
    else
      warn "No log file found. Check: brew services info postgresql@17"
    fi
  fi
}

# Help
cmd_help() {
  cat <<'HELP'
PortOS Database Manager

Usage: scripts/db.sh <command>

Commands:
  status         Show database status (both Docker and native)
  start          Start the database (uses current mode)
  stop           Stop the database
  fix            Fix stale postmaster.pid and other issues
  logs           Tail database logs

  setup-native   Detect/install PostgreSQL, create portos database
  use-docker     Switch to Docker mode (port 5561)
  use-native     Switch to native/system mode (port 5432)

  migrate        Export from current mode, import to the other
  export [label] Export database to data/db-dumps/
  import <file>  Import a SQL dump file

Environment:
  PGMODE=docker|native   Set in .env to control default mode
  PGPORT=5432            PostgreSQL port (native=5432, docker=5561)
  PGPASSWORD=portos      Database password
HELP
}

# Main dispatch
case "${1:-help}" in
  status)       cmd_status ;;
  start)        cmd_start ;;
  stop)         cmd_stop ;;
  fix)          cmd_fix ;;
  setup-native) cmd_setup_native ;;
  use-docker)   cmd_use_docker ;;
  use-native)   cmd_use_native ;;
  migrate)      cmd_migrate ;;
  export)       cmd_export "${2:-}" ;;
  import)       cmd_import "${2:?Usage: scripts/db.sh import <file>}" ;;
  logs)         cmd_logs ;;
  help|--help|-h) cmd_help ;;
  *)            err "Unknown command: $1"; cmd_help; exit 1 ;;
esac
