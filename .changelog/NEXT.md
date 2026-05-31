# Unreleased Changes

## Added

## Changed

- **[media-job-store-progress-on-job-record] Render queue rows now hydrate live progress from the job record.** The media job queue now stores `progress` and `statusMsg` on the running job whenever image/video runners emit progress or status events, exposes those fields through `GET /api/media-jobs/:id` and list responses, and preserves them in persisted queue snapshots. The Image / Video render queue uses that snapshot to show a compact progress bar during polling, so non-SSE consumers no longer reset in-flight jobs to 0% until the next live event arrives.

- Bumped the bundled slashdo submodule (`lib/slashdo`) to latest `main` (`11cb89c`).

## Fixed

## Removed
