// =============================================================================
// PM2 Ecosystem Configuration - shared constants and app definitions
// =============================================================================
const path = require('path');
const fs = require('fs');

const LOG_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSS[Z]';
const IS_WIN = process.platform === 'win32';

const BASE_ENV = {
  NODE_ENV: 'development',
  TZ: 'UTC'
};

function readDotEnv(filePath) {
  const result = {};
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return result; }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

const envFile = path.join(__dirname, '.env');
const dotEnv = readDotEnv(envFile);
const envValue = (key, fallback = null) => process.env[key] || dotEnv[key] || fallback;

const pgMode = envValue('PGMODE', 'docker');
const envMaxMemory = envValue('PORTOS_SERVER_MAX_MEMORY', null);
const pgHost = envValue('PGHOST', 'localhost');
const pgUser = envValue('PGUSER', 'portos');
const pgDatabase = envValue('PGDATABASE', 'portos');
const pgPassword = envValue('PGPASSWORD', 'portos');
const pgDockerPort = envValue('PGPORT_DOCKER', '5561');
const pgPort = envValue('PGPORT', pgMode === 'docker' ? pgDockerPort : '5432');

const SERVER_MAX_MEMORY = envValue('PORTOS_SERVER_MAX_MEMORY', envMaxMemory || '4G');

const PORTS = {
  API: 5555,
  API_LOCAL: 5553,
  UI: 5554,
  CDP: 5556,
  CDP_HEALTH: 5557,
  COS: 5558,
  AUTOFIXER: 5559,
  AUTOFIXER_UI: 5560,
  POSTGRES_DOCKER: 5561,
  POSTGRES: Number.parseInt(pgPort, 10) || (pgMode === 'native' || pgMode === 'network' ? 5432 : 5561)
};

const PG_ENV = {
  PGHOST: pgHost,
  PGPORT: String(PORTS.POSTGRES),
  PGDATABASE: pgDatabase,
  PGUSER: pgUser,
  PGPASSWORD: pgPassword
};

module.exports = {
  PORTS,

  apps: [
    {
      name: 'portos-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        ...PG_ENV,
        PORT: PORTS.API,
        PORTOS_HTTP_PORT: PORTS.API_LOCAL,
        HOST: '0.0.0.0',
        ...(pgMode === 'file' ? { MEMORY_BACKEND: 'file' } : {}),
        PATH: process.env.PATH
      },
      watch: false,
      max_memory_restart: SERVER_MAX_MEMORY
    },
    {
      name: 'portos-cos',
      script: 'server/cos-runner/index.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.COS,
        HOST: '127.0.0.1'
      },
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '2G',
      kill_timeout: 30000
    },
    {
      name: 'portos-ui',
      script: path.join(__dirname, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
      cwd: path.join(__dirname, 'client'),
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      args: `--host 0.0.0.0 --port ${PORTS.UI}`,
      env: {
        ...BASE_ENV,
        VITE_PORT: PORTS.UI
      },
      watch: false
    },
    {
      name: 'portos-autofixer',
      script: 'autofixer/server.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.AUTOFIXER,
        PATH: process.env.PATH
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    },
    {
      name: 'portos-autofixer-ui',
      script: 'autofixer/ui.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        PORT: PORTS.AUTOFIXER_UI
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    },
    {
      name: 'portos-browser',
      script: 'browser/server.js',
      cwd: __dirname,
      interpreter: 'node',
      log_date_format: LOG_DATE_FORMAT,
      windowsHide: IS_WIN,
      env: {
        ...BASE_ENV,
        CDP_PORT: PORTS.CDP,
        CDP_HOST: '127.0.0.1',
        PORT: PORTS.CDP_HEALTH
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000
    }
  ]
};
