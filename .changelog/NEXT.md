# Unreleased

## Added

- Editorial Checks page now has an AI provider + model selector that configures the editorial pass. Leave it on "Default provider" to use the active/stage provider, or pick a specific provider/model to override the LLM-backed checks for that run.

## Fixed

- **The GitHub Release workflow no longer crashes on a large changelog.** The v2.22.0 release (a ~175KB changelog) failed at the "Create Release" step with `Argument list too long`: the changelog was passed to `softprops/action-gh-release` as the `body:` input, which GitHub materializes as an `INPUT_BODY` environment variable, and a 175KB env var overflows `ARG_MAX` when the action's Node process is exec'd. The body also exceeds GitHub's hard 125,000-character release-note limit (a separate HTTP 422). The workflow now writes the (placeholder-substituted) changelog to a file and feeds it via `body_path:` instead of an env var, and caps it at 120,000 chars on a whole-line boundary — appending a pointer to the full changelog file at the tag when truncated. (`.github/workflows/release.yml`)
