# Unreleased Changes

## Added

## Changed

- **Pipeline series arc — inline theme editing.** Theme pills on the Series Arc card are now directly editable: click a pill to rename, hover for the × to remove, click the dashed "+ Add theme" chip to append (up to 20 themes, 100 chars each — matching `ARC_LIMITS` on the server). Writes are optimistic with a single-flight save gate so a blur-then-click sequence can't double-persist against stale state. The redundant comma-separated themes input was removed from the "Edit arc" form; logline / summary / protagonist arc / shape still live there.

## Fixed

## Removed
