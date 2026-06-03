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

const isPublicPath = (path) => {
  if (PUBLIC_API_PATHS.has(path)) return true;
  // Static client assets ship in client/dist/. Gating them is pointless — the
  // index.html is just the bootstrap loader, and a sidecar attacker can't do
  // anything with it without a token to hit the JSON API. Letting them through
  // also keeps the login page itself reachable.
  return !path.startsWith('/api/') && !path.startsWith('/data/');
};

// Express middleware. Bypasses everything when auth is off. When it's on,
// allows the small public set above; gates the rest behind a valid token in
// the cookie or Authorization: Bearer header.
export const authGate = async (req, res, next) => {
  const enabled = await isAuthEnabled();
  if (!enabled) return next();
  const path = req.path;
  if (isPublicPath(path)) return next();
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
  const token = extractToken(fakeReq);
  if (await verifySession(token)) return next();
  const err = new Error('Authentication required');
  err.data = { code: 'AUTH_REQUIRED' };
  next(err);
};
