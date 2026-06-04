# Unreleased

## Added

- **[issue-708] Digital Twin "Voice" tab — spoken vs. written style** — Paste a transcript of yourself speaking and the Digital Twin compares it against how you write (a pasted sample, or your existing twin documents), surfacing where your spoken voice differs from your writing — formality, verbosity, sentence length, directness, filler words — and suggesting a communication profile for voice contexts that you can apply in one click.
- **[issue-711] "While You Were Away" dashboard card** — A new dashboard widget recaps what your agents did since your last visit: a count of completed runs, success/failure tally, total time worked, and the most recent wins plus anything that failed and needs a look. Each item opens the agents view, and a "Mark as seen" button resets the window to now. It appears on the Everything and Agent Watch layouts and can be added to any layout via Arrange.
- **[issue-708] Digital Twin "Appearance" tab — image identity source** — Upload a photo of yourself and a vision-capable provider extracts your visible appearance and self-presentation (apparent age range, build, hair, style, grooming, vibe, setting, expression). Review and edit the generated write-up, then save it as your "Appearance & Presentation" core identity document so the twin has a grounded sense of how you look. Use a local vision model (LM Studio / Ollama) to keep the photo on-device; the image itself is never persisted, only the derived text.

## Changed

- **[issue-875] CyberCity district layout internals consolidated** — the city's districts now share one set of layout primitives for grid placement, category tallies, and log-scaled building heights, so each district no longer carries its own copy of that math. No visible change to the city.
