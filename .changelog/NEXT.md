## Changed

- **[issue-875] CyberCity district layout internals consolidated** — the city's districts now share one set of layout primitives for grid placement, category tallies, and log-scaled building heights, so each district no longer carries its own copy of that math. No visible change to the city.
