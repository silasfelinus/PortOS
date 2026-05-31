# Unreleased Changes

## Added

## Changed

- Bumped the bundled slashdo submodule (`lib/slashdo`) to latest `main` (`11cb89c`).

## Fixed

- **[ltx2-fflf-skips-last-image-resize-when-both-frames-set] ltx2 FFLF now resizes both anchor frames.** The two-keyframe ltx2 FFLF path passes both `--image` and `--last-image` into `scripts/generate_ltx2.py`, but Video Gen only resized the start image when both anchors were present. The end frame could therefore reach `KeyframeInterpolationPipeline.generate_and_save()` at its original dimensions. `videoGen/local.js` now treats ltx2 true-FFLF as a real last-image consumer and runs the same ffmpeg resize/crop pass used for multi-keyframes, with a regression test asserting the helper receives resized start and end paths.

## Removed
