# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.

## Changed

- **[issue-722]** Prompt-template migrations now scan their files concurrently, so future multi-file updates apply faster.

## Fixed

- **[issue-717] No stray React warnings when you navigate away mid-action** — buttons that run an async task (save, generate, sync) no longer log an "update on an unmounted component" warning if you leave the page before the task finishes.
- **[issue-719] Steadier media galleries during live note/star sync** — incoming annotation broadcasts that match what a view already shows no longer trigger a needless re-render of the media cards.

## Removed
