import { extractToken, isAuthEnabled, verifySession } from '../services/auth.js';

// Paths that bypass the auth gate even when a password is set:
//   - /api/auth/status, /api/auth/whoami, /api/auth/login → the login UI
//     itself needs to reach these to render and sign in.
//   - /api/system/health — Tailscale's reachability check shouldn't need a
//     session.
// Anything not on this list returns 401 when auth is on and the request has
// no valid token.
const PUBLIC_API_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/whoami',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/system/health',
]);

// Non-`/api` API surfaces that must also be gated. `/sdapi/v1/*` is the
// AUTOMATIC1111-compatible image-gen mount served by sdapiRoutes — it accepts
// generation requests and exposes the LoRA / model catalog, so a sidecar with
// network reach but no auth must NOT be able to hit it. Add to this list any
// future routes that live outside `/api`.
const GATED_NON_API_PREFIXES = ['/sdapi/'];

const isPublicPath = (path) => {
  if (PUBLIC_API_PATHS.has(path)) return true;
  // /api/* and /data/* are always gated. /sdapi/* (and any future non-/api
  // API surface listed above) is also gated. Everything else is the static
  // client bundle — index.html / hashed JS+CSS / fonts — which is safe to
  // serve without a session: a sidecar can't do anything with it without a
  // token to hit the JSON API, and the login page itself must be reachable.
  if (path.startsWith('/api/') || path.startsWith('/data/')) return false;
  for (const prefix of GATED_NON_API_PREFIXES) {
    if (path.startsWith(prefix)) return false;
  }
  return true;
};

// Reject cross-origin requests when auth is on. PortOS's CORS middleware
// reflects `Origin` with `Access-Control-Allow-Credentials: true` so the UI
// works from any tailnet hostname / IP — but combined with the session
// cookie that becomes a CSRF surface: a malicious page on another tailnet
// host can fetch PortOS APIs with `credentials: 'include'` after the user
// has logged in (Tailscale's `ts.net` is on the Public Suffix List, so
// SameSite=Lax doesn't help — same-tailnet hosts are same-site). Match the
// `Origin` header's host:port against the request's own `Host` header; any
// mismatch is a cross-origin attempt and gets 403 before the session is
// even consulted. Requests with no `Origin` header (server-to-server,
// curl, the loopback mirror) pass through.
const isCrossOrigin = (req) => {
  const origin = req.headers?.origin;
  if (!origin || origin === 'null') return false;
  const host = req.headers?.host;
  if (!host) return false;
  // URL parses scheme://authority — we only compare the authority. A
  // malformed Origin (URL constructor throws) is treated as cross-origin.
  let parsed;
  try { parsed = new URL(origin); }
  catch { return true; }
  return parsed.host !== host;
};

// Express middleware. Bypasses everything when auth is off. When it's on,
// allows the small public set above; gates the rest behind a valid token in
// the cookie or Authorization: Bearer header.
export const authGate = async (req, res, next) => {
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  const path = req.path;
  if (isPublicPath(path)) return next();
  // CSRF guard runs BEFORE the cookie check — a cross-origin request must
  // be rejected even if it carries a valid session, otherwise an attacker
  // with no cookie still triggers side effects whose response the browser
  // hides but whose mutations have already landed.
  if (isCrossOrigin(req)) {
    res.status(403).json({ error: 'Cross-origin request rejected', code: 'CROSS_ORIGIN_BLOCKED' });
    return;
  }
  const token = extractToken(req);
  if (await verifySession(token)) return next();
  // /data/* is hit directly by <img>/<audio>/<video> tags which don't show a
  // structured-JSON error — return a plain 401 there. API callers expect the
  // PortOS error envelope.
  if (path.startsWith('/data/')) {
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }
  res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
};

// Socket.IO middleware. Run after a successful HTTP-side handshake — same
// `req.headers.cookie` is available on `socket.handshake.headers`. When auth
// is off, every connection is allowed; when on, the handshake must carry a
// valid cookie/header.
export const socketAuthGate = async (socket, next) => {
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  const fakeReq = { headers: socket.handshake?.headers || {} };
  if (isCrossOrigin(fakeReq)) {
    const err = new Error('Cross-origin request rejected');
    err.data = { code: 'CROSS_ORIGIN_BLOCKED' };
    return next(err);
  }
  const token = extractToken(fakeReq);
  if (await verifySession(token)) return next();
  const err = new Error('Authentication required');
  err.data = { code: 'AUTH_REQUIRED' };
  next(err);
};
