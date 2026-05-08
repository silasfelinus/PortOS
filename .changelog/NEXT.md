# Unreleased Changes

## Added

- **Dismissible AI Recommendations on the Learning tab.** Each recommendation in the Chief of Staff Learning Analytics panel now has an X to dismiss it. Dismissals persist to `data/cos/dismissed-recommendations.json` and are filtered out of future loads. For count-based alerts (e.g., "unknown errors occurred 74 times"), the dismissal records the count snapshot and only re-surfaces if the count grows materially worse (≥1.5× and at least +20). Rate-based recommendations stay dismissed until restored. A "Show dismissed" expander lets you restore individual entries or clear them all.
