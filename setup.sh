#!/bin/bash
set -e

echo "==================================="
echo "  PortOS Setup"
echo "==================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js is required but not installed."
    echo "Install it from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Node.js 18+ required (found v$NODE_VERSION)"
    exit 1
fi

# `npm run setup` is the all-in-one: submodules + root/client/server/autofixer
# deps + esbuild postinstall + node-pty rebuild + data dir, db, and browser
# setup. install:all is kept as a backward-compat alias.
echo "Installing dependencies and running setup..."
if ! npm run setup; then
    echo ""
    echo "==================================="
    echo "  Setup incomplete"
    echo "==================================="
    echo ""
    echo "Fix the issue above, then re-run: ./setup.sh"
    echo ""
    exit 1
fi

echo ""

# Install/update slash-do (project-level slash commands for Claude Code et al.)
# via npx. Auto-detects the installed AI environments and lays down the latest
# command set under ~/.claude/commands (or per-environment equivalent). The
# git submodule at lib/slashdo is the in-repo source for inline command loading
# from CoS agents — `npx slash-do@latest` complements that by keeping the
# user-global command pool current. Failures are non-fatal: PortOS still works
# without the global slash commands.
echo "Installing/updating slash-do commands (npx slash-do@latest)..."
# Pipe "a" so slash-do's "multiple environments detected" prompt auto-selects
# all detected envs instead of hanging on readline when stdin is not a TTY.
if ! echo a | npx --yes slash-do@latest; then
    echo "⚠️  slash-do install failed — skipping (you can re-run later: npx slash-do@latest)"
fi
echo ""

# Optional Ghostty setup. Skip on non-TTY (CI, piped stdin) so `read` doesn't
# abort the script under `set -e`, and `||` the read itself so a Ctrl-D in an
# interactive shell defaults to "skip" instead of aborting.
if [ -t 0 ]; then
    setup_ghostty=""
    read -p "Set up Ghostty terminal themes? (y/N): " setup_ghostty || true
    if [[ $setup_ghostty =~ ^[Yy]$ ]]; then
        node scripts/setup-ghostty.js
    fi
fi

echo ""

# Optional: start PortOS now. Accept y/yes/Y/YES (and Enter) to start, n/no
# to skip, and reprompt on anything else so a stray "asdf" doesn't silently
# launch pm2. On non-TTY (CI, piped stdin) default to "no" so the script
# completes unattended without auto-launching pm2. A Ctrl-D inside the loop
# is treated as "no" so the script can still finish cleanly.
start_now=0
if [ -t 0 ]; then
    while true; do
        answer=""
        if ! read -p "Start PortOS now via pm2? (Y/n): " answer; then
            start_now=0
            break
        fi
        case "$answer" in
            ""|[Yy]|[Yy][Ee][Ss])
                start_now=1
                break
                ;;
            [Nn]|[Nn][Oo])
                start_now=0
                break
                ;;
            *)
                echo "Please answer yes or no (y/n)."
                ;;
        esac
    done
fi

# Print the URL the user should open. The server flips between HTTP and HTTPS
# on :5555 based on whether data/certs/{cert,key}.pem exist (see
# lib/tailscale-https.js). When HTTPS is active, :5555 speaks TLS only — plain
# http://localhost:5555 hits a TLS mismatch — and a loopback HTTP mirror spawns
# on :5553 (or $PORTOS_HTTP_PORT) for cert-free local access.
print_access_url() {
    if [ ! -f data/certs/cert.pem ] || [ ! -f data/certs/key.pem ]; then
        echo "Access at: http://localhost:5555"
        return
    fi
    local mirror_port="${PORTOS_HTTP_PORT:-5553}"
    # Read cert mode from meta.json — self-signed certs cover localhost + local
    # IPv4s but not the Tailscale hostname; Tailscale LE certs cover the
    # tailnet hostname but not localhost. The advertised URLs must match the
    # cert's SAN coverage or we'll send users to a URL their browser rejects.
    local cert_mode=""
    if [ -f data/certs/meta.json ]; then
        cert_mode=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('data/certs/meta.json','utf8')).mode||'')}catch{}" 2>/dev/null)
    fi
    echo "Access at: http://localhost:${mirror_port}  (loopback HTTP mirror — no cert warning)"
    if [ "$cert_mode" = "tailscale" ]; then
        echo "       or: https://<machine>.<tailnet>.ts.net:5555  (trusted via Tailscale)"
        echo "       or: https://localhost:5555  (browser warns — cert is for the Tailscale hostname)"
    elif [ "$cert_mode" = "self-signed" ]; then
        echo "       or: https://localhost:5555  (browser warns on first visit — self-signed cert)"
    else
        echo "       or: https://localhost:5555  (browser may warn on cert)"
    fi
}

if [ "$start_now" = "1" ]; then
    echo ""
    echo "Starting PortOS..."
    npm start
    # Open the dashboard in the PortOS-managed browser. Fail-soft.
    node scripts/open-ui-in-browser.js || true
    echo ""
    echo "==================================="
    echo "  PortOS is running"
    echo "==================================="
    echo ""
    print_access_url
    echo "Logs:      npm run pm2:logs"
    echo "Stop:      npm run pm2:stop"
    echo ""
else
    echo "==================================="
    echo "  Setup Complete!"
    echo "==================================="
    echo ""
    echo "Start PortOS:"
    echo "  Development:  npm run dev"
    echo "  Production:   npm start (or npm run pm2:start)"
    echo "  Stop:         npm run pm2:stop"
    echo "  Logs:         npm run pm2:logs"
    echo ""
    print_access_url
    echo ""
fi
