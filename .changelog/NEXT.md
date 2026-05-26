# Release vNEXT

Released: TBD

## Overview

TBD

## Added

- **Set your home location in Settings → General.** Enter a latitude and longitude and the voice assistant's weather command ("what's the weather?") reports conditions for where you are instead of a default city. Leave both fields blank to fall back to the default location.

## Changed

- **Pick any AI provider for the voice assistant.** The voice Chief-of-Staff's language model was hard-wired to LM Studio. Settings → Voice now has an "LLM provider" picker listing every API provider you've configured (LM Studio, Ollama, NVIDIA, or any OpenAI-compatible endpoint) plus a model dropdown with a refresh button that re-queries the provider's available models. Local-only setups are unchanged out of the box — LM Studio stays the default and the `LM_STUDIO_URL` override still applies — but you can now point voice at a hosted model. The voice service-health badge probes whichever provider you select.
- **Consistent inline badge styling.** The peer relationship and connection-scheme labels on the Instances page and the length-target cards in the Writers Room Guide now render through one shared badge component, so their look stays consistent as more badges are added.

## Fixed

- **Merging duplicate universes now shows what's being combined.** When you fold two duplicate universes (or series) together, the merge dialog only ever asked you to resolve scalar conflicts like the starter prompt — the list-shaped fields (style prompt and negative prompt chips, categories, characters/places/objects, composite sheets, seasons) were silently unioned with no indication it happened. The dialog now lists each list field the folded copy contributes to, with a running "N total · +N folded in" count, so the no-data-loss combine is visible instead of feeling like those fields were ignored.
- **[peer-sync-per-category-version-gate] Machines on different PortOS versions keep syncing everything except the one changed data type.** When one federated machine updates to a version that changes how a single kind of data is stored (universes, comics, or media collections), the others used to refuse the *entire* sync until they caught up — silently stalling all data between them. Now only transfers of the changed data type wait for the lagging machine to update; every other kind keeps flowing.
- **Voice timers survive a restart and no longer double-fire.** A timer or reminder you set by voice ("remind me in 30 minutes to call mom") is now saved to disk, so it still goes off if PortOS restarts before it's due — any that came due while it was down fire as soon as it's back. A single request can no longer arm two timers, so you won't get the same reminder twice.
- **Federated media collections: a merged-away duplicate no longer survives on peers.** When a universe (or series) *merge* tombstones the loser's auto-collection, a receiving peer applies the universe tombstone first — and its cascade (`unlinkCollectionsForUniverse` / `unlinkCollectionsForSeries`) was stamping the linked collection's `updatedAt` to "now", which then defeated the collection's own (older) tombstone under Last-Writer-Wins and left a live duplicate "Universe: X" collection on the peer. The cascade unlink now **preserves `updatedAt`** (it's a derived side-effect of the owner's deletion, not a user edit), so the collection tombstone still wins and both machines converge to deleted. Items are never lost — they're always unioned on merge.
- **Federated sync metadata no longer grows without bound.** When a duplicate universe or series is merged away (or otherwise force-pruned), its leftover entry in the cross-machine sync base-hash file used to linger forever. Those orphaned entries are now removed as part of the prune, so the file doesn't slowly accumulate dead rows on long-lived federated installs.

## Removed
