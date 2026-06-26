#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * Ensures PostgreSQL is available in one of three supported modes:
 * - docker: PortOS-managed Docker Compose PostgreSQL
 * - native: system PostgreSQL on this machine
 * - network: PostgreSQL hosted elsewhere, usually on the same tailnet
 *
 * Called by: npm run setup, npm run update, npm start, npm run dev
 */

import { execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvFile, upsertEnvKey } from './lib/envFile.js';
import { resolveBashBinary } from '../server/lib/bashResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, '.env');
const envFile = parseEnvFile(envPath);

const envVar = (key, fallback) => process.env[key] ?? envFile[key] ?? fallback;

const parsePgPort = (value, fallback = 5432) => {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDockerPort = (value) => {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : 5561;
};

const PG_USER = envVar('PGUSER', 'portos');
const PG_DATABASE = envVar('PGDATABASE', 'portos');
const PG_PASSWORD = envVar('PGPASSWORD', 'portos');
const PG_HOST = envVar('PGHOST', 'localhost');
const PG_PORT_NATIVE = parsePgPort(envVar('PGPORT', 5432), 5432);
const PG_PORT_NETWORK = parsePgPort(envVar('PGPORT', 5432), 5432);
const PG_PORT_DOCKER = parseDockerPort(envVar('PGPORT_DOCKER', 5561));

function getMode() {
  return String(envVar('PGMODE', 'docker')).trim().toLowerCase();
}

function activePgHost(mode = getMode()) {
  return mode === 'docker' ? 'localhost' : PG_HOST;
}

function activePgPort(mode = getMode()) {
  if (mode === 'docker') return PG_PORT_DOCKER;
  if (mode === 'network') return PG_PORT_NETWORK;
  return PG_PORT_NATIVE;
}

function pgChildEnv(mode = getMode()) {
  return {
    ...process.env,
    PGHOST: activePgHost(mode),
    PGUSER: PG_USER,
    PGDATABASE: PG_DATABASE,
    PGPASSWORD: PG_PASSWORD,
    PGPORT: String(activePgPort(mode))
  };
}

function hasCommand(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function hasPsql() {
  return hasCommand('psql', ['--version']);
}

function hasDocker() {
  return hasCommand('docker', ['--version']);
}

function isDockerRunning() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isContainerRunning() {
  try {
    const output = execFileSync('docker', ['compose', 'ps', '--format', 'json', 'db'], {
      stdio: 'pipe',
      cwd: rootDir
    }).toString();
    return output.includes('"running"') || output.includes('"Running"');
  } catch {
    return false;
  }
}

function runPsqlSql(sql, mode = getMode(), database = PG_DATABASE) {
  return execFileSync(
    'psql',
    [
      '-X',
      '-h', activePgHost(mode),
      '-p', String(activePgPort(mode)),
      '-U', PG_USER,
      '-d', database,
      '-tAc',
      sql
    ],
    { stdio: 'pipe', env: pgChildEnv(mode) }
  ).toString();
}

function canConnect(mode = getMode()) {
  if (!hasPsql()) return false;
  try {
    const output = runPsqlSql('SELECT 1', mode);
    return output.trim() === '1';
  } catch {
    return false;
  }
}

function isPortOSDbReady(mode = getMode()) {
  if (!hasPsql()) return false;
  try {
    const output = runPsqlSql(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1",
      mode
    );
    return output.trim() === '1';
  } catch {
    return false;
  }
}

function isDockerSchemaReady() {
  try {
    const output = execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-X', '-U', 'portos', '-d', 'portos', '-tAc',
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1"],
      { stdio: 'pipe', cwd: rootDir }
    ).toString();
    return output.trim() === '1';
  } catch {
    return false;
  }
}

function waitForHealth(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-h', '127.0.0.1', '-U', 'portos'], {
        stdio: 'pipe',
        cwd: rootDir
      });
      if (isDockerSchemaReady()) return true;
    } catch {
      // not accepting TCP connections yet
    }
    if (i < maxAttempts - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  return false;
}

function getDockerHints(issue) {
  const platform = process.platform;
  const hints = { install: '', start: '' };

  if (platform === 'darwin') {
    hints.install = 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/';
    hints.start = 'Open Docker Desktop or run: open -a Docker';
  } else if (platform === 'win32') {
    hints.install = 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/';
    hints.start = 'Start Docker Desktop from the Start menu';
  } else {
    hints.install = 'Install Docker Engine: https://docs.docker.com/engine/install/';
    hints.start = 'Start Docker: sudo systemctl start docker';
  }

  return issue === 'not_installed' ? hints.install : hints.start;
}

function setEnvKey(key, value) {
  upsertEnvKey(envPath, key, value);
}

function setPgMode(mode) {
  setEnvKey('PGMODE', mode);
}

function setNetworkPgDefaults({ host, port, database, user, password }) {
  setEnvKey('PGMODE', 'network');
  setEnvKey('PGHOST', host);
  setEnvKey('PGPORT', String(port));
  setEnvKey('PGDATABASE', database);
  setEnvKey('PGUSER', user);
  setEnvKey('PGPASSWORD', password);
}

function promptQuestion(question, fallback = '') {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = fallback ? ` [${fallback}]` : '';
    rl.question(`   ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || fallback);
    });
  });
}

function promptYesNo(question, defaultYes = false) {
  return new Promise((resolve) => {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`   ${question} ${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(defaultYes);
        return;
      }
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}

async function promptNetworkConfig() {
  console.log('🌐 Configure networked PostgreSQL');
  console.log('   Use the Tailscale/MagicDNS host if possible, not a LAN IP.');
  console.log('');

  const host = await promptQuestion('PostgreSQL host', PG_HOST === 'localhost' ? 'ferngrotto' : PG_HOST);
  const port = parsePgPort(await promptQuestion('PostgreSQL port', String(PG_PORT_NETWORK)), 5432);
  const database = await promptQuestion('Database name', PG_DATABASE);
  const user = await promptQuestion('Database user', PG_USER);
  const password = await promptQuestion('Database password', PG_PASSWORD);

  setNetworkPgDefaults({ host, port, database, user, password });

  return { host, port, database, user, password };
}

function promptStorageChoice(message, hint) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`❌ ${message}`);
    console.error(`   ${hint}`);
    console.error('   PostgreSQL is required. Start Docker, set up native PostgreSQL, or set PGMODE=network with PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.');
    process.exit(1);
  }

  return new Promise((resolve) => {
    console.log(`⚠️  ${message}`);
    console.log(`   ${hint}`);
    console.log('');
    console.log('   Choose a PostgreSQL hosting mode:');
    console.log('');
    console.log('   1) Docker PostgreSQL (recommended for local, containerized dev)');
    console.log('   2) Native PostgreSQL (system PostgreSQL on this machine)');
    console.log('   3) Networked PostgreSQL (Unraid/NAS/server reachable over Tailscale)');
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Enter choice [1/2/3]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '2') resolve('native');
      else if (trimmed === '3') resolve('network');
      else resolve('exit');
    });
  });
}

function applyRemoteSchema(mode = 'network') {
  const initSql = join(rootDir, 'server', 'scripts', 'init-db.sql');

  try {
    console.log('🧬 Ensuring required extensions exist...');
    try {
      runPsqlSql('CREATE EXTENSION IF NOT EXISTS vector', mode);
    } catch (err) {
      console.warn(`⚠️  Could not create vector extension: ${err.message}`);
      console.warn('   The PostgreSQL image/server must have pgvector installed.');
    }

    try {
      runPsqlSql('CREATE EXTENSION IF NOT EXISTS pgcrypto', mode);
    } catch (err) {
      console.warn(`⚠️  Could not create pgcrypto extension: ${err.message}`);
    }

    console.log('📜 Applying PortOS schema...');
    execFileSync(
      'psql',
      [
        '-X',
        '-h', activePgHost(mode),
        '-p', String(activePgPort(mode)),
        '-U', PG_USER,
        '-d', PG_DATABASE,
        '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f', initSql
      ],
      { stdio: 'inherit', env: pgChildEnv(mode) }
    );

    return isPortOSDbReady(mode);
  } catch (err) {
    console.error(`❌ Could not apply PortOS schema: ${err.message}`);
    return false;
  }
}

async function setupNetworkPostgres({ promptForMissing = false } = {}) {
  if (promptForMissing && process.stdin.isTTY && process.stdout.isTTY) {
    await promptNetworkConfig();
  }

  if (!hasPsql()) {
    console.error('❌ psql not found on this machine.');
    console.error('   Install PostgreSQL client tools, then rerun setup.');
    console.error('   Windows: install PostgreSQL or use winget install PostgreSQL.PostgreSQL');
    console.error('   macOS: brew install libpq && brew link --force libpq');
    process.exit(1);
  }

  console.log(`🌐 Checking networked PostgreSQL at ${activePgHost('network')}:${activePgPort('network')}...`);

  if (isPortOSDbReady('network')) {
    setPgMode('network');
    console.log(`✅ PortOS database ready at ${activePgHost('network')}:${activePgPort('network')}`);
    process.exit(0);
  }

  if (!canConnect('network')) {
    console.error(`❌ Cannot connect to PostgreSQL at ${activePgHost('network')}:${activePgPort('network')}`);
    console.error('   Confirm the Unraid container is running, port 5432 is published, and Tailscale can reach the host.');
    console.error('   Then rerun: npm run setup:db');
    process.exit(1);
  }

  console.warn('⚠️  Connected, but the PortOS schema is not ready yet.');

  const shouldApply = process.stdin.isTTY && process.stdout.isTTY
    ? await promptYesNo('Apply PortOS schema to this database now?', true)
    : false;

  if (!shouldApply) {
    console.error('❌ Networked database needs the PortOS schema before boot.');
    console.error('   Apply server/scripts/init-db.sql to the database, then rerun setup.');
    process.exit(1);
  }

  if (applyRemoteSchema('network')) {
    setPgMode('network');
    console.log(`✅ PortOS database ready at ${activePgHost('network')}:${activePgPort('network')}`);
    process.exit(0);
  }

  console.error('❌ Networked PostgreSQL is reachable, but PortOS schema validation failed.');
  process.exit(1);
}

function setupNativePostgres() {
  const dbScript = join(rootDir, 'scripts', 'db.sh');
  try {
    console.log('🍺 Running native PostgreSQL setup...');
    execFileSync(resolveBashBinary(), [dbScript, 'setup-native'], {
      stdio: 'inherit',
      cwd: rootDir,
      env: pgChildEnv('native')
    });
    if (isPortOSDbReady('native')) {
      console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
      return true;
    }
  } catch (err) {
    console.error(`⚠️  Native setup error: ${err.message}`);
  }
  return false;
}

function exitNativeSetupFailed() {
  if (process.platform === 'darwin') {
    console.error('❌ Native PostgreSQL setup failed — try manually: brew install postgresql@17 && brew services start postgresql@17');
  } else {
    console.error('❌ Native PostgreSQL setup failed — install and start PostgreSQL');
  }
  console.log('   Then re-run: npm run setup');
  process.exit(1);
}

async function handleDockerUnavailable(message, issue) {
  if (isPortOSDbReady('native')) {
    console.log('   Healthy native PostgreSQL detected — using native mode.');
    setPgMode('native');
    console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
    process.exit(0);
  }

  if (PG_HOST !== 'localhost' && isPortOSDbReady('network')) {
    console.log('   Healthy networked PostgreSQL detected — using network mode.');
    setPgMode('network');
    console.log(`✅ PortOS database ready at ${PG_HOST}:${PG_PORT_NETWORK}`);
    process.exit(0);
  }

  const hint = getDockerHints(issue);
  const choice = await promptStorageChoice(message, hint);

  if (choice === 'native') {
    console.log('   Switching to native PostgreSQL mode...');
    setPgMode('native');

    if (isPortOSDbReady('native')) {
      console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
      process.exit(0);
    }

    if (setupNativePostgres()) {
      process.exit(0);
    }

    exitNativeSetupFailed();
  }

  if (choice === 'network') {
    await setupNetworkPostgres({ promptForMissing: true });
  }

  console.log(`   ${hint}`);
  console.log('   Install/start Docker and re-run setup');
  process.exit(1);
}

const mode = getMode();

if (mode === 'file') {
  console.error('🚫 PGMODE=file is UNSUPPORTED for production — PostgreSQL is required.');
  console.error('   File-based storage has no creative-catalog or vector-search support.');
  console.log('   Switch to a supported mode with: scripts/db.sh set-mode native (or docker/network)');
  process.exit(0);
}

console.log(`🗄️  Setting up PostgreSQL (mode: ${mode})...`);

if (mode === 'network') {
  await setupNetworkPostgres();
}

if (mode === 'native') {
  if (isPortOSDbReady('native')) {
    console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
    process.exit(0);
  }

  if (setupNativePostgres()) {
    process.exit(0);
  }

  exitNativeSetupFailed();
}

if (mode !== 'docker') {
  console.error(`❌ Unknown PGMODE: ${mode}`);
  console.error('   Supported modes: docker, native, network');
  process.exit(1);
}

if (!hasDocker()) {
  await handleDockerUnavailable('Docker not found — skipping database setup', 'not_installed');
}

if (!isDockerRunning()) {
  await handleDockerUnavailable('Docker daemon not running — skipping database setup', 'not_running');
}

if (!hasCompose()) {
  await handleDockerUnavailable('docker compose not available — skipping database setup', 'not_installed');
}

if (isContainerRunning()) {
  if (waitForHealth()) {
    console.log('✅ PostgreSQL already running');
    process.exit(0);
  }
  console.error('❌ PostgreSQL container is running but not accepting connections');
  console.error('   Check status: docker compose logs db');
  process.exit(1);
}

console.log('🐳 Starting PostgreSQL container...');
try {
  execFileSync('docker', ['compose', 'up', '-d', 'db'], {
    stdio: 'inherit',
    cwd: rootDir
  });
} catch (err) {
  console.error(`❌ Failed to start PostgreSQL container: ${err.message}`);
  console.error('   PostgreSQL is required — try native or network mode instead:');
  console.error('   scripts/db.sh use-native && npm run setup');
  console.error('   Or set PGMODE=network with PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD');
  process.exit(1);
}

console.log('⏳ Waiting for PostgreSQL to be ready...');
if (waitForHealth()) {
  console.log(`✅ PostgreSQL ready on port ${PG_PORT_DOCKER}`);
} else {
  console.error('❌ PostgreSQL started but never became ready');
  console.error('   Check status: docker compose logs db');
  process.exit(1);
}
