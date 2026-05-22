# Unreleased Changes

## Added

## Changed

## Fixed
- Auto-run the world → universe data rename on server boot. The conversion previously shipped as a manual CLI script (`server/scripts/migrateWorldToUniverse.js`) that nobody knew to invoke, so installs upgrading from the World Builder era kept stale `data/world-builder.json` files and never saw their worlds appear as universes. The new migration `031-world-to-universe-data-rename.js` does the file rename, top-level key rename (`worlds`→`universes`), `worldId`→`universeId` rewrite in `pipeline-series.json`, `worldRun`→`universeRun` rewrite in `media-jobs.json`, and also relinks any `"World: <name>"` render collections in `media-collections.json` to their universe by canonical-name match.

## Removed
