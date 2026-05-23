# Unreleased Changes

## Added

- `/work <task>` Claude Code slash command (`.claude/commands/work.md`) — slugifies the task, spins up a fresh git worktree under `.claude/worktrees/<slug>/` branched off local `main` (NOT current HEAD), `cd`s into it, carries out the work without disturbing the originating checkout's uncommitted edits / branch / HEAD, and on completion always chains `/simplify` → `/do:pr --review-with codex,gemini,copilot` so the work lands as a reviewed PR. Branch / dir collision auto-suffixes with `-2`, `-3`, etc. `.claude/worktrees/` is already gitignored.

## Changed

## Fixed

## Removed
