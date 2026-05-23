# Unreleased Changes

## Added

- `/work <task>` Claude Code slash command (`.claude/commands/work.md`) — slugifies the task, spins up a fresh git worktree under `.claude/worktrees/<slug>/` branched off local `main` (NOT current HEAD), `cd`s into it, carries out the work without disturbing the originating checkout's uncommitted edits / branch / HEAD, and on completion always chains `/simplify` → `/do:review --with codex,gemini` → `/do:pr --review-with copilot` so codex + gemini findings are addressed locally *before* the PR opens (otherwise Copilot kicks in immediately on unreviewed code and burns review cycles). Branch / dir collision auto-suffixes with `-2`, `-3`, etc. `.claude/worktrees/` is already gitignored.

## Changed

## Fixed

## Removed
