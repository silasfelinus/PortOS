# Unreleased Changes

## Added

- Codex image gen: hi-res resolution presets (1024×1536, 1536×1024, 1536×1536) — gpt-image-1's native hi-res tier. Picking any ≥1536 size automatically appends a `(high quality)` hint to the codex prompt so the model renders at full fidelity instead of its 1024 default.

## Changed

- Image Gen resolution dropdown now filters by the selected backend. Flux-bucketed sizes (832×1216 / 1216×832) only appear for Flux 1/2 and external; the new 1536 hi-res tier only appears for codex and Flux 2. Z-Image-Turbo and ERNIE (trained at 1024²) now hide both groups to prevent users from picking sizes the model can't handle. A stale incompatible selection falls through to a `(custom)` option so the value stays visible until the user picks a supported one.
