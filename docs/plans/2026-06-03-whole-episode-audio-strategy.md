# Whole-Episode Audio Generation Strategy

**Investigation / design spike** for GitHub issue #736. This is a design record, not
an implementation — it resolves the two open dimensions the issue called out
(generator family + granularity) and specifies a ready-to-build `audioMode`
data shape, route/contract changes, and how it dovetails with the existing
per-clip audio path and the generator-agnostic `generateMusic` contract.

## Context

Today an episode's background audio is assembled *per clip / per pointer*, not
*per episode*:

- The audio stage (`stages.audio`) carries a flat `lines[]` of voice-over and a
  **single** `music` descriptor — `{ source: 'upload'|'library'|'gen',
  trackFilename, label }` (`server/services/pipeline/issues.js`,
  `sanitizeMusicTrack`). There is exactly one music pointer per issue.
- At episode-stitch time `maybeMuxPipelineAudio`
  (`server/services/creativeDirector/stitchRunner.js`) resolves that one track,
  loops it under the whole video (`muxMusicBed`), or — when placed VO lines
  exist — ducks it under dialogue (`muxVoLines`,
  `server/services/pipeline/audioMux.js`). The music bed is *one looped file*
  cut to the video length; it has no relationship to the episode's prose/script
  arc.
- The only generator behind `source: 'gen'` is MusicGen-MLX
  (`server/services/pipeline/musicGen.js` → `scripts/generate_musicgen.py`),
  bounded to a 1–30s window (`MIN_DURATION_SEC`/`MAX_DURATION_SEC`). Its public
  contract is `generateMusic({ prompt, durationSec, modelId, signal }) →
  { filename, durationSec, modelId, model }` — deliberately generator-agnostic
  so a sibling engine plugs in behind the same call.

The problem: a single 12–30s loop dragged across a multi-minute episode ignores
the *narrative shape* the episode already encodes (acts, scenes, emotional
beats). We want audio that follows the episode's arc, and we want the user to be
able to choose how the soundtrack is sourced at all (none, generated,
hand-supplied, or the current per-clip behavior).

The issue proposes a new selector:

```
audioMode: 'per-clip' | 'silent' | 'generated' | 'uploaded-track'
```

and asks the spike to resolve two design dimensions before any code lands.

## Dimension 1 — Generator family

The candidates, with trade-offs weighed against PortOS's "local OSS first,
on-device, no API key" media posture and the single-user/many-installs
distribution model:

| Family | Example | Duration control | Cost / privacy | Quality | Verdict |
|---|---|---|---|---|---|
| **Local-bounded** | MusicGen-MLX (already shipped) | Hard ~30s ceiling; degrades past its training window | Free, fully on-device, no key | Good for short stings/cues | **Keep** as the short-cue generator |
| **Local long-form** | AudioLDM2 (issue #735, in progress) | Minutes-scale, real duration control on-device | Free, on-device, no key | Adequate ambient/score beds | **Adopt as the default `generated` engine** once #735 lands |
| **Commercial** | Suno (HTTP API) | True arbitrary duration, song-grade output | Per-call cost, API key, sends prompt off-device | Best | **Pluggable sibling**, opt-in, never the default |

### Decision

**Tiered, generator-agnostic — no single winner; the family is chosen per
request behind the existing `generateMusic` contract.**

1. **Short cues / stings** stay on **MusicGen-MLX**. It already ships, needs no
   network, and its ≤30s window is exactly right for a per-arc cue or scene
   transition.
2. **Long-form episode/scene beds** target the **AudioLDM2 local long-form
   sidecar from issue #735** — referenced here as the *expected* long-form
   generator (this spike does not implement it; #735 owns that). When #735 lands
   it becomes the **default engine for `audioMode: 'generated'`** because it can
   produce minutes-scale audio entirely on-device, matching the local-first
   posture without the 30s ceiling.
3. **Commercial (Suno et al.)** remains a **pluggable sibling** behind the same
   `generateMusic` contract — opt-in only, never the default, because it costs
   money, requires a key, and sends the prompt off-device (a privacy regression
   for a single-user private-network product). It is *enabled* by this design
   (the engine field below) but *not provisioned* by it.

Rationale: the existing `generateMusic` signature is already engine-agnostic
(the module header explicitly anticipates "a future 3rd-party engine … plug in
here as a sibling generator behind the same contract"). The right move is to
*select* an engine per request rather than hard-pick one family. This keeps each
generator's strengths (MusicGen's fast local stings, AudioLDM2's long-form local
beds, Suno's premium song-grade output) addressable without re-architecting.

### Contract change to `generateMusic`

Add an explicit **`engine`** selector and let the engine decide its own duration
ceiling, instead of MusicGen's hard 30s clamp leaking into the whole pipeline:

```js
// server/services/pipeline/musicGen.js (today: MusicGen only)
generateMusic({ prompt, durationSec, modelId, signal })
  → { filename, durationSec, modelId, model }

// proposed (engine-dispatched; signature is additive + backward compatible)
generateMusic({
  prompt,
  durationSec,
  engine = 'musicgen',        // 'musicgen' | 'audioldm2' | 'suno' | …
  modelId,                    // engine-scoped model id (musicgen-medium, etc.)
  signal,
})
  → { filename, durationSec, engine, modelId, model }
```

- `engine` defaults to `'musicgen'` so **every existing caller is unchanged**
  (backward/forward compat across installs — older clients that omit `engine`
  still get the current behavior).
- The **duration clamp moves into the engine**. MusicGen keeps its 1–30s window;
  AudioLDM2 advertises its own (minutes-scale) window; the dispatcher clamps
  against the *selected* engine's limits, so a 90s request routes to a long-form
  engine instead of being silently truncated to 30s.
- `MUSICGEN_MODELS` generalizes to a per-engine registry (a small in-module
  constant per engine, same as today — not the image/video `media-models.json`
  machinery). The `GET /audio/music/generators` route returns the union,
  each entry tagged with its `engine` and ready/availability flag (mirroring
  `isMusicGenReady()` per engine, so the UI can gate the "Generate" affordance
  per engine rather than globally).

This is the *only* change the spike asks of `musicGen.js`, and it is **deferred
to the implementing PR** — this doc does not touch the file (to avoid colliding
with #735, which is concurrently editing the same module to add the AudioLDM2
backend). #735 should add its engine *through* this dispatcher shape rather than
as a parallel ad-hoc path; if #735 lands first, the implementing PR for #736
adapts to whatever engine-registration seam #735 introduced.

## Dimension 2 — Granularity

How much audio structure does an episode get?

| Granularity | What it means | Pros | Cons |
|---|---|---|---|
| **One track / episode** | a single bed under the whole episode (today's behavior, but arc-aware prompt) | Simplest; one render; no transition seams | Ignores intra-episode beats; tonal monotony over a long episode |
| **Per-scene beds** | one bed per storyboard scene | Each scene gets matching tone; aligns with the existing scene structure | Many renders; audible seams at scene cuts unless crossfaded; storyboard scene count can be high |
| **Per-arc cues** | one cue per *narrative arc beat* (act/sequence), spanning the scenes in that beat | Follows the emotional shape the episode already encodes; far fewer cues than scenes; natural cue boundaries at act turns | Needs an arc → time-range mapping; mid-cue tonal shifts within a long arc beat |

### Decision

**Per-arc cues, with a single-track floor and a per-scene path left open.**

The episode already has a narrative arc structure: `arcPlanner`
(`server/services/pipeline/arcPlanner.js`) produces the act/sequence breakdown,
and storyboards carry per-scene timing the muxer already uses for VO placement
(`offsetSec`). **Per-arc cues** are the design target because:

- They follow the *emotional* shape of the episode (tension rise, climax,
  resolution) rather than the *mechanical* shape (every scene cut), which is
  what "drive audio from the episode-level prose/script arc" (the issue's core
  ask) actually means.
- An episode has a handful of arc beats but can have many scenes — per-arc keeps
  the render count and the number of audible transition seams low.
- Cue boundaries fall at act/sequence turns, which are *natural* musical
  transition points; a crossfade at an act break reads as intentional, where a
  crossfade at every scene cut reads as choppy.

To keep the first implementation tractable and degrade gracefully, the design is
**tiered**:

1. **Floor (v1 implementable immediately):** `audioMode: 'generated'` with **one
   arc-aware track** — a single long-form bed whose *prompt* is synthesized from
   the whole-episode arc summary (so even the single-track case is "driven by the
   episode-level prose/script arc," satisfying the issue) and whose *duration* is
   the episode length (long-form engine). This is a small delta over today's
   single-`music`-pointer path.
2. **Target (per-arc cues):** an ordered `cues[]` array, one cue per arc beat,
   each with its own prompt + a `startSec`/`endSec` time range derived from the
   arc → scene-timing mapping. The muxer concatenates/crossfades cues along the
   timeline.
3. **Future (per-scene beds):** the *same* `cues[]` shape with cue boundaries set
   at scene granularity instead of arc granularity — no schema change, just a
   different boundary-derivation strategy. This is why the data shape below is
   **cue-based rather than arc-specific**: per-scene is a configuration of the
   same structure, not a new one.

## `audioMode` design

### Data shape (`stages.audio`)

Add an `audioMode` discriminator to the audio stage and a `cues[]` array
alongside the existing single `music` pointer. The existing `music` field is
**retained** and means "the single uploaded/library/single-gen track" — it is
the `uploaded-track` and legacy paths; `cues[]` is the new arc/scene-driven path.

```jsonc
// stages.audio (sanitized shape; additions marked +)
{
  "status": "empty|in_progress|complete",
  "lines": [ /* unchanged VO lines */ ],

  // + which strategy drives the episode's non-dialogue audio.
  //   Absent / unknown  → 'per-clip'  (backward-compatible default; see migration)
  "audioMode": "per-clip" | "silent" | "generated" | "uploaded-track",

  // existing single-track pointer — now scoped to 'uploaded-track' (and the
  // legacy single-gen case). Unchanged shape, unchanged sanitizer.
  "music": { "source": "upload|library|gen", "trackFilename": "…", "label": "…" } | null,

  // + arc/scene-driven cues, used when audioMode === 'generated'. Empty for
  //   every other mode. Ordered by startSec.
  "cues": [
    {
      "id": "cue-001",                  // stable id (like line ids)
      "label": "Act I — setup",         // human label (arc beat name or scene id)
      "prompt": "warm ambient pads, …", // engine prompt (arc-summary-derived)
      "engine": "audioldm2",            // which generator rendered it
      "startSec": 0,                    // timeline placement (derived from arc→scene timing)
      "endSec": 84.5,                   // null until placed (mirrors line offsetSec sentinel)
      "trackFilename": "music-gen-….wav" | null, // null until rendered
      "durationSec": 84.5 | null,       // actual rendered length
      "gain": 0.5 | null                // per-cue gain override; null → stage default
    }
  ]
}
```

**Sentinel discipline** (per CLAUDE.md "absent vs intentionally empty" and
"sentinel + validate"):

- `audioMode` absent → treat as `'per-clip'` (today's behavior). A migration
  (below) stamps the explicit value so the field is never ambiguous on read.
- A cue's `endSec`/`trackFilename`/`durationSec` are `null` until placed/rendered
  — exactly like `sanitizeLineOffset`'s `null = "not placed yet"` vs `0 = "plays
  at start"` distinction. The muxer skips un-rendered/un-placed cues rather than
  stacking them at t=0.
- `gain: null` means "use the stage/global default," distinct from `0` ("muted").

### Mode semantics at stitch time

`maybeMuxPipelineAudio` (`stitchRunner.js`) branches on `audioMode`:

| `audioMode` | Music bed behavior | VO lines | Clip's own audio |
|---|---|---|---|
| `per-clip` | **No episode-level bed** — preserve each stitched clip's own soundtrack (today's `clipAudio` path). | Ducked over clip audio if placed | Preserved (LTX-2 audio-to-video) |
| `silent` | Strip / no bed | Ducked over silence | **Stripped** |
| `generated` | Concatenate/crossfade `cues[]` along the timeline, each cue at its `startSec..endSec`; gaps fall back to silence (or a designated bed cue) | Ducked over the cue bed | Preserved + ducked |
| `uploaded-track` | Loop the single `music.trackFilename` under the whole episode (today's `muxMusicBed`/`muxVoLines` path) | Ducked over the looped bed | Preserved + ducked |

- `per-clip` formalizes today's "no music pointer → keep clip audio" behavior as
  an explicit, user-selectable mode (it is the default so nothing changes for
  existing issues).
- `uploaded-track` is exactly today's single-`music` path — zero muxer change.
- `generated` is the new path. It needs a **multi-cue muxer**: a `buildCueMuxArgs`
  sibling to `buildVoMuxArgs` that lays each cue's file at its `startSec` (via
  `adelay`, the same primitive `buildVoMuxArgs` already uses), crossfades
  adjacent cues at their boundaries (`acrossfade`), then ducks the combined bed
  under VO via the existing `sidechaincompress` key. The VO mixing,
  clip-audio-preservation, and `-shortest` machinery in `audioMux.js` is reused
  verbatim — the only addition is the cue-bed assembly upstream of the duck.

### Route / contract changes

All additive; all validated via Zod per the PortOS convention. None implemented
in this spike.

1. **`audioMode` PATCH.** Extend `audioStageInputSchema`
   (`server/routes/pipeline.js`) to accept `audioMode` (enum) and `cues` (array;
   light validation, sanitizer enforces per-cue shape — mirroring how `music`
   and `lines` are handled today). The base PATCH
   `PATCH /issues/:id/stages/audio` then persists the mode.

2. **Cue generation.** `POST /issues/:id/stages/audio/cues/generate` — derive the
   per-arc cue list from the issue's arc (`arcPlanner` output) + storyboard scene
   timing: one cue per arc beat, each with an arc-summary-derived prompt and a
   `startSec`/`endSec` time range. Returns the populated (but un-rendered)
   `cues[]`. This is the "drive audio from the episode-level prose/script arc"
   core — the prompt for each cue is synthesized from that beat's prose summary.

3. **Cue render.** `POST /issues/:id/stages/audio/cues/:cueIdx/render` — calls
   `generateMusic({ prompt, durationSec: endSec-startSec, engine, … })` for one
   cue and stamps `trackFilename`/`durationSec`. Mirrors the existing per-line
   `render` route (`/stages/audio/lines/:lineIdx/render`). A "render all cues"
   convenience can iterate server-side.

4. **Generators list.** `GET /audio/music/generators` already exists; extend its
   payload so each generator entry carries its `engine` + per-engine ready flag
   (so the UI gates "Generate" per engine).

5. **Sanitizer.** Add `sanitizeAudioMode` (enum allow-list, default `'per-clip'`)
   and `sanitizeAudioCue`/`cues[]` to `sanitizeAudioStage`
   (`server/services/pipeline/issues.js`), alongside the existing
   `sanitizeMusicTrack`. Keep `sanitizeLineOffset`'s sentinel pattern for
   `startSec`/`endSec`.

### Migration & compatibility (distribution model)

PortOS is many independent installs + federated sync peers, so the on-disk shape
change needs the full compat treatment:

- **On-disk migration** in `scripts/migrations/NNN-…js`: for every existing
  issue, stamp `stages.audio.audioMode` based on the current `music` pointer —
  `music` present → `'uploaded-track'` (preserve the user's existing track);
  `music` absent → `'per-clip'` (preserve today's behavior). Initialize
  `cues: []`. Applied-list tracked in `data/migrations.applied.json` per the
  existing convention.
- **Read-side default.** The sanitizer defaults absent `audioMode` to
  `'per-clip'` so an un-migrated record (or one synced from an older peer) reads
  correctly before the migration runs — never let "absent" collapse into a
  wrong mode.
- **Cross-machine sync.** The `cues[]` addition is a new field on an existing
  synced record. Per `server/lib/schemaVersions.js`, the audio-stage payload's
  schema version must bump so a newer peer's `cues[]` doesn't corrupt an older
  peer that doesn't know the field; the older peer keeps `music`-only behavior
  and ignores `cues[]` it can't render. Mirror any client-side `pick` helper for
  the audio stage so the round-trip stays symmetric.

## What this spike does NOT do

- Does **not** edit `server/services/pipeline/musicGen.js`,
  `server/services/pipeline/audioMux.js`, `scripts/generate_musicgen.py`, or any
  other audio-pipeline code — it is a doc-only design record (issue #736 is an
  investigation spike, and #735 is concurrently editing `musicGen.js`).
- Does **not** implement the AudioLDM2 backend — that is issue #735. This design
  *references* it as the expected long-form engine and specifies the
  engine-dispatch seam it should register through.
- Does **not** pick a commercial provider — Suno is enabled by the `engine`
  field but left unprovisioned.

## Implementation order (for the follow-up PR(s))

1. **Schema + migration** — `audioMode` enum + `cues[]` sanitizer, the
   `'per-clip'`/`'uploaded-track'` migration, schema-version bump. (Self-contained;
   no engine dependency.)
2. **`generateMusic` engine dispatch** — `engine` param + per-engine duration
   clamp + per-engine generators list. Coordinate with / build on #735's
   AudioLDM2 registration.
3. **Cue generation + render routes** — arc → cue derivation, per-cue render.
4. **Multi-cue muxer** — `buildCueMuxArgs` + `audioMode` branch in
   `maybeMuxPipelineAudio`.
5. **AudioStage UI** — mode selector, cue list with per-cue prompt/render/place,
   per-engine "Generate" gating.

Steps 1 and 2 are independent and can land in either order; 3–5 depend on both.
```
