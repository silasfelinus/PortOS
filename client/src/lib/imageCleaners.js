// Client mirror of `resolveCleanersFromConfig` from `server/lib/imageClean.js`.
// The server is authoritative — keep the two copies in sync. Used by the
// Settings ImageGenTab and the per-render ImageGen page so both surfaces
// agree on how the saved per-mode settings map into the two-flag world.
// Legacy `autoClean: true` no longer carries into denoise — upgrading users
// who never explicitly chose denoise get it off (it's lossy and blurs text).

export function resolveCleanersFromConfig(modeCfg) {
  const cfg = modeCfg || {};
  return {
    cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : true,
    denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : false,
  };
}
