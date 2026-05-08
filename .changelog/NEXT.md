# Unreleased Changes

## Added

- **Dismissible AI Recommendations on the Learning tab.** Each recommendation in the Chief of Staff Learning Analytics panel now has an X to dismiss it. Dismissals persist to `data/cos/dismissed-recommendations.json` and are filtered out of future loads. For count-based alerts (e.g., "unknown errors occurred 74 times"), the dismissal records the count snapshot and only re-surfaces if the count grows materially worse (≥1.5× and at least +20). Rate-based recommendations stay dismissed until restored. A "Show dismissed" expander lets you restore individual entries or clear them all.

## Changed

- **Browser downloads default to `~/Downloads`.** The CDP browser previously sent downloads to `data/browser-downloads/` inside the project; it now writes to the OS-native user Downloads directory (`~/Downloads` on macOS/Linux, `C:\Users\<u>\Downloads` on Windows) via `os.homedir()`. Both the keep-alive `Browser.setDownloadBehavior` call in `browser/server.js` and `PATHS.browserDownloads` in `server/lib/fileUtils.js` were updated so the Browser page UI's listing/delete operations stay in sync with where Chrome actually writes. Existing installs without an explicit `downloadDir` in `data/browser-config.json` pick up the new location automatically; users who want the old behavior can pin it by setting `downloadDir` in that config file.
