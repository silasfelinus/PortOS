// /ecosystem.unraid.cjs
const base = require('./ecosystem.config.cjs')

const defaultApps = ['portos-server', 'portos-cos']

const requestedApps = (process.env.PORTOS_UNRAID_APPS || defaultApps.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

const selectedApps = new Set(requestedApps)

module.exports = {
  ...base,
  apps: base.apps
    .filter((app) => selectedApps.has(app.name))
    .map((app) => ({
      ...app,
      env: {
        ...app.env,
        NODE_ENV: 'production',
        HOST:
          app.name === 'portos-server'
            ? '0.0.0.0'
            : app.env?.HOST || '127.0.0.1',
        PGHOST: process.env.PGHOST || 'db',
        PGPORT: process.env.PGPORT || '5432',
        PGUSER: process.env.PGUSER || 'portos',
        PGDATABASE: process.env.PGDATABASE || 'portos',
        PGPASSWORD: process.env.PGPASSWORD || 'portos',
        PORTOS_SERVER_MAX_MEMORY: process.env.PORTOS_SERVER_MAX_MEMORY || '4G',
        PATH: process.env.PATH
      }
    }))
}
