# Unreleased Changes

## Fixed

- **[issue-968] A PM2 hiccup no longer makes running apps look offline** — when PortOS briefly can't read process state, affected apps now show as "status unavailable" instead of being silently reported as stopped, and the system health page flags the degraded read rather than quietly counting those apps as never started.
