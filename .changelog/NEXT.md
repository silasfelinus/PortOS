# Unreleased Changes

## Fixed

- **[issue-968] A PM2 hiccup no longer makes running apps look offline** — when PortOS briefly can't read process state, affected apps now show "status unavailable" instead of being silently reported as stopped. The Apps list and detail pages replace the (misleading) Start button with a refresh-to-retry control, the dashboard counts these separately, the system health page flags the degraded read, and CyberCity no longer rains on apps whose status simply couldn't be read.
