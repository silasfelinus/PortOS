# Unreleased Changes

## Added

## Changed

## Fixed
- Auto-run the world → universe data rename on server boot. The conversion previously shipped as a manual CLI script (`server/scripts/migrateWorldToUniverse.js`) that nobody knew to invoke, so installs upgrading from the World Builder era kept stale `data/world-builder.json` files and never saw their worlds appear as universes. The new migration `031-world-to-universe-data-rename.js` does the file rename, top-level key rename (`worlds`→`universes`), `worldId`→`universeId` rewrite in `pipeline-series.json`, `worldRun`→`universeRun` rewrite in `media-jobs.json`, and also relinks any `"World: <name>"` render collections in `media-collections.json` to their universe by canonical-name match.
- Universe Builder picker dropdown rendered beneath the tab subnav and downstream section cards in Lumen Glass / Blueprint Ops themes. Those themes ship a non-`none` `--port-backdrop-filter`, and the global rule in `index.css` applies it to every `.bg-port-card.border.rounded*` — which turns each such card into its own stacking context. The picker's `absolute z-30` dropdown was trapped inside the header card's context and couldn't paint over later sibling cards. Adding `relative z-30` to the picker's `<header>` lets that stacking context win against subsequent siblings so the dropdown overlays them as intended.

## Removed
