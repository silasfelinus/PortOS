# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.

## Changed

## Fixed

- **[issue-719] Steadier media galleries during live note/star sync** — incoming annotation broadcasts that match what a view already shows no longer trigger a needless re-render of the media cards.

## Removed
