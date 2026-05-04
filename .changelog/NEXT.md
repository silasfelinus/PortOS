# Unreleased Changes

## Fixed

- Writers-room storyboard renders queued through Codex now wait their turn instead of erroring with "A Codex generation is already in progress" when you fire a second render before the first finishes. Codex jobs run on their own queue lane, so they don't block (and aren't blocked by) local image or video renders.

## Added

- Video Gen "Chunks" control (1–8) chains multiple LTX renders into a single longer clip. Each chunk's last frame seeds the next, then ffmpeg stitches them into one output. The individual chunks land in history hidden by default, so the gallery shows just the stitched result.

## Changed

- Release workflow no longer silently skips creating the GitHub Release when something else pushed the version tag before the workflow ran.
- Release-notes style guide tightened — entries should be one sentence per change in user-facing language, not code-review prose with file paths and internal symbols.
- Chief of Staff 3D avatars (Cyber, Sigil, Esoteric, Nexus, Muse) now fill the agent panel as a full-bleed background, with the title, status, and controls overlaying the scene instead of sharing a column with it.
- Autonomy level buttons in the CoS Config tab now use higher-contrast active states so the selected level is obvious at a glance.
