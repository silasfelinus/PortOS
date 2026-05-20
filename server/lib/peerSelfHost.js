// Returns the Tailscale-issued hostname this PortOS sends in federation
// announces. Self-signed mode binds to localhost + IPs, which can't be
// announced as a host, so falls through to null.
import { readFileSync, statSync } from 'node:fs';
import { PATHS, safeJSONParse } from './fileUtils.js';
import { certPaths } from '../../lib/certPaths.js';

const { meta: META_PATH } = certPaths(PATHS.data);

export function getSelfHost() {
  if (process.env.PORTOS_HOST) return process.env.PORTOS_HOST;

  const stat = statSync(META_PATH, { throwIfNoEntry: false });
  if (!stat) return null;

  // safeJSONParse so a partially-written meta.json (mid setup:cert) doesn't
  // throw at every announce/probe — getSelfHost is called in hot paths.
  const meta = safeJSONParse(readFileSync(META_PATH, 'utf-8'), null);
  if (!meta) return null;
  return meta.mode === 'tailscale' && typeof meta.hostname === 'string' && meta.hostname
    ? meta.hostname
    : null;
}
