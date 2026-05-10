# Unreleased Changes

## Added

- Codex image gen: hi-res resolution presets (1024×1536, 1536×1024, 1536×1536) — gpt-image-2's native hi-res tier. Picking any ≥1536 size automatically appends a `(high quality)` hint to the codex prompt so the model renders at full fidelity instead of its 1024 default.
- Image Gen batch mode: a `× N` count input next to the Generate button (async modes only — local + codex) queues N renders of the same prompt+resolution in a single submit. The first job streams its progress live; the remaining N-1 land in the server queue and surface as `+N queued`. Each job gets a fresh random seed by default so the batch produces variations, not duplicates.
- Media Lightbox full-screen mode (`F` key or top-right toggle): drops the modal's rounding and padding and lets the image fill the viewport. Swipe left/right (or arrow keys) navigates between gallery items; tap reveals the settings as a slide-in drawer. Layered Escape closes drawer → exits full-screen → closes the lightbox. The Seed row in the settings pane is now copyable for easy reuse in a remix.
- Media Lightbox surfaces a `Codex session` row for gpt-image-2 renders (the session-id from the codex CLI banner, written to the image's sidecar metadata). Closest analogue to a seed for codex output — copyable for traceability. The Seed row now reads `n/a (gpt-image-2)` for codex images instead of hiding, so it's clear why no seed is present.

## Changed

- Image Gen resolution dropdown now filters by the selected backend. Flux-bucketed sizes (832×1216 / 1216×832) only appear for Flux 1/2 and external; the new 1536 hi-res tier only appears for codex and Flux 2. Z-Image-Turbo and ERNIE (trained at 1024²) now hide both groups to prevent users from picking sizes the model can't handle. A stale incompatible selection falls through to a `(custom)` option so the value stays visible until the user picks a supported one.

## Fixed

- Render Queue UI now lists jobs in execution order (running first, then queue position ascending) instead of mixing a long-running job into the middle of newer queued batches. The route was sorting all jobs by `startedAt || queuedAt` DESC, which slotted an active job below a fresher batch.
