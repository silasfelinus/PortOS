# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.

## Changed

- **[issue-722]** Prompt-template migrations now scan their files concurrently, so future multi-file updates apply faster.

## Fixed

## Removed
