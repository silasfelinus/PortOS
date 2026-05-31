# Unreleased Changes

## Added

## Changed

- **[chrome-canary-followups] Custom Chrome setup writes browser config through the shared atomic writer.** The Canary setup script now uses `server/lib/fileUtils.js#atomicWrite` for browser-config updates, so it gets the same temp-file/rename behavior and Windows fallback as the rest of PortOS config persistence.
- **[media-job-store-progress-on-job-record] Render queue rows now hydrate live progress from the job record.** The media job queue now stores `progress` and `statusMsg` on the running job whenever image/video runners emit progress or status events, exposes those fields through `GET /api/media-jobs/:id` and list responses, and preserves them in persisted queue snapshots. The Image / Video render queue uses that snapshot to show a compact progress bar during polling, so non-SSE consumers no longer reset in-flight jobs to 0% until the next live event arrives.
- **[shared-bounded-concurrency-mapper] Bounded-concurrency worker pool extracted to a shared helper.** The cursor-based worker-pool idiom that was hand-rolled in `embeddings.js`, `catalogExtraction.js`, and `routes/imageVideoModels.js` is now a single tested `server/lib/mapWithConcurrency.js` (order-preserving, concurrency-bounded), with all three call sites migrated and behavior unchanged.
- Bumped the bundled slashdo submodule (`lib/slashdo`) to latest `main` (`11cb89c`).

## Fixed

- **[ltx2-fflf-skips-last-image-resize-when-both-frames-set] ltx2 FFLF now resizes both anchor frames.** The two-keyframe ltx2 FFLF path passes both `--image` and `--last-image` into `scripts/generate_ltx2.py`, but Video Gen only resized the start image when both anchors were present. The end frame could therefore reach `KeyframeInterpolationPipeline.generate_and_save()` at its original dimensions. `videoGen/local.js` now treats ltx2 true-FFLF as a real last-image consumer and runs the same ffmpeg resize/crop pass used for multi-keyframes, with a regression test asserting the helper receives resized start and end paths.
- **[ref-watch-phosphene-teacache-extend-a2v-denoise] TeaCache now accelerates ltx2 Extend and A2V Stage 1.** `scripts/generate_ltx2.py` now patches the LTX-2 `extend` and `a2vid_two_stage` denoise-loop import sites (the modules where `ExtendPipeline`/`AudioToVideoPipeline` actually call `guided_denoise_loop`), activating the existing Stage-1 TeaCache controller only around Extend and A2V calls and clearing the gate afterward. TeaCache stays default-on for those slow paths, with `--no-teacache` to opt out and `--teacache-thresh` to trade fidelity for speed (~1.2× at the 0.5 default, up to ~3× at 1.5).

## Removed
