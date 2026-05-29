// Shared semantic-tone banner primitive. Replaces the hand-rolled
// `<div className="bg-port-warning/10 border border-port-warning/30 rounded p-2 …">`
// (and matching success/error/info variants) that were copy-pasted across the
// client.
//
// Knobs map to real call-site shapes — nothing speculative:
//   tone     — semantic color trio (text + bg-tint + border). `warning` is the
//              default since that's the dominant in-repo usage.
//   icon     — optional leading lucide glyph component (e.g. `AlertTriangle`).
//   size     — `sm` (px-3 py-2 / text-xs, dense — default), `md` (px-4 py-3 /
//              text-sm), or `lg` (p-4 / text-sm). Icon scales with size.
//   title    — optional bold first line. Body styling is left to children so
//              callers can mix tone-muted, gray-400 sub-text, links, etc.
//   actions  — optional right-side slot (e.g. a button) — sits on the same row
//              as the icon + title block.
//   className — passthrough for layout tweaks (e.g. `mb-6`); merged after the
//              tone classes so callers can override defaults if needed.
//
// Any extra props pass through to the wrapping `<div>`.

// Each tone pre-composes every full class name it needs — Tailwind's JIT
// scans for complete tokens, so `${t.text}/30` would NOT generate the
// `border-port-warning/30` utility. Spell it out.
const TONES = {
  warning: {
    wrapper: 'border-port-warning/30 bg-port-warning/10 text-port-warning',
    iconColor: 'text-port-warning',
  },
  error: {
    wrapper: 'border-port-error/30 bg-port-error/10 text-port-error',
    iconColor: 'text-port-error',
  },
  success: {
    wrapper: 'border-port-success/30 bg-port-success/10 text-port-success',
    iconColor: 'text-port-success',
  },
  info: {
    wrapper: 'border-port-accent/30 bg-port-accent/10 text-port-accent',
    iconColor: 'text-port-accent',
  },
};

const SIZES = {
  sm: { padding: 'px-3 py-2', text: 'text-xs', iconSize: 14, gap: 'gap-2' },
  md: { padding: 'px-4 py-3', text: 'text-sm', iconSize: 16, gap: 'gap-2' },
  lg: { padding: 'p-4', text: 'text-sm', iconSize: 20, gap: 'gap-3' },
};

export default function Banner({
  tone = 'warning',
  icon: Icon,
  size = 'sm',
  title,
  actions,
  className = '',
  children,
  ...rest
}) {
  const t = TONES[tone] || TONES.warning;
  const s = SIZES[size] || SIZES.sm;

  // Border-radius scales with size — small banners use `rounded`, larger ones
  // use `rounded-lg` to match the surrounding call sites in the repo.
  const radius = size === 'lg' || size === 'md' ? 'rounded-lg' : 'rounded';

  return (
    <div
      className={`${s.padding} ${s.text} border ${radius} ${t.wrapper} flex items-start ${s.gap} ${className}`.trim()}
      {...rest}
    >
      {Icon ? (
        <Icon size={s.iconSize} className={`shrink-0 mt-0.5 ${t.iconColor}`} />
      ) : null}
      <div className="flex-1 min-w-0">
        {title ? <div className="font-medium">{title}</div> : null}
        {children}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
