import { join } from 'path';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { atomicWrite, PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { getSettings, updateSettings } from './settings.js';
import { ServerError } from '../lib/errorHandler.js';

// Auth gates the PortOS UI + API behind a single user-set password. PortOS is
// single-user (one human per install) so there are no usernames or roles —
// just a password and a session token. The password hash + salt live under
// `secrets.auth` in settings.json so the existing GET /api/settings sanitizer
// (which strips `secrets`) keeps them off the wire.

const scryptAsync = promisify(scrypt);

const SESSIONS_FILE = join(PATHS.data, 'auth-sessions.json');
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'portos_auth';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

// In-memory session store. Keyed by token → { expiresAt }. Persisted to disk on
// every mutation so tokens survive server restarts (handy when PM2 reloads on
// update). A single-user install rarely has more than a handful of live
// sessions; a Map keeps this simple.
const sessions = new Map();
let loaded = false;

const now = () => Date.now();

const readSessions = async () => {
  const raw = await tryReadFile(SESSIONS_FILE);
  const parsed = safeJSONParse(raw ?? '{}', {});
  if (!Array.isArray(parsed.tokens)) return;
  const cutoff = now();
  for (const entry of parsed.tokens) {
    if (!entry?.token || typeof entry.expiresAt !== 'number') continue;
    if (entry.expiresAt <= cutoff) continue;
    sessions.set(entry.token, { expiresAt: entry.expiresAt });
  }
};

const writeSessions = async () => {
  const tokens = [];
  for (const [token, { expiresAt }] of sessions) {
    tokens.push({ token, expiresAt });
  }
  await atomicWrite(SESSIONS_FILE, JSON.stringify({ tokens }, null, 2) + '\n');
};

const ensureLoaded = async () => {
  if (loaded) return;
  loaded = true;
  await readSessions().catch((err) => {
    console.error(`❌ Failed to load auth sessions: ${err.message}`);
  });
};

const hashPassword = async (password, salt) => {
  const buf = await scryptAsync(password, salt, HASH_BYTES, SCRYPT_PARAMS);
  return buf.toString('hex');
};

const constantEqual = (aHex, bHex) => {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const readAuthConfig = async () => {
  const settings = await getSettings();
  return settings?.secrets?.auth ?? null;
};

export const isAuthEnabled = async () => {
  const auth = await readAuthConfig();
  return !!(auth?.enabled && auth?.passwordHash && auth?.salt);
};

export const getAuthStatus = async () => {
  const enabled = await isAuthEnabled();
  return { enabled };
};

// Set or replace the password. When `currentPassword` is provided we verify it
// against the stored hash first; pass `null` for the first-time set. Returns a
// fresh session token so the caller can stay signed in after a change.
export const setPassword = async ({ newPassword, currentPassword = null }) => {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new ServerError('Password must be at least 8 characters', { status: 400, code: 'AUTH_PASSWORD_TOO_SHORT' });
  }
  if (newPassword.length > 256) {
    throw new ServerError('Password too long', { status: 400, code: 'AUTH_PASSWORD_TOO_LONG' });
  }
  const existing = await readAuthConfig();
  if (existing?.enabled) {
    const ok = typeof currentPassword === 'string'
      && existing.passwordHash
      && existing.salt
      && constantEqual(await hashPassword(currentPassword, existing.salt), existing.passwordHash);
    if (!ok) {
      throw new ServerError('Current password is incorrect', { status: 401, code: 'AUTH_BAD_CURRENT' });
    }
  }
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const passwordHash = await hashPassword(newPassword, salt);
  const settings = await getSettings();
  const secrets = { ...(settings.secrets || {}) };
  secrets.auth = {
    enabled: true,
    kdf: 'scrypt',
    passwordHash,
    salt,
    updatedAt: new Date().toISOString(),
  };
  await updateSettings({ secrets });
  // Existing sessions are invalidated on password change — the user (or anyone
  // holding a stolen token) starts over.
  await revokeAllSessions();
  return createSession();
};

// Clear the password entirely (turn auth off). Mirrors setPassword's
// current-password check so the disable can't happen without proof of identity.
export const clearPassword = async ({ currentPassword }) => {
  const existing = await readAuthConfig();
  if (!existing?.enabled) return { enabled: false };
  const ok = typeof currentPassword === 'string'
    && existing.passwordHash
    && existing.salt
    && constantEqual(await hashPassword(currentPassword, existing.salt), existing.passwordHash);
  if (!ok) {
    throw new ServerError('Current password is incorrect', { status: 401, code: 'AUTH_BAD_CURRENT' });
  }
  const settings = await getSettings();
  const secrets = { ...(settings.secrets || {}) };
  delete secrets.auth;
  await updateSettings({ secrets });
  await revokeAllSessions();
  return { enabled: false };
};

export const verifyPassword = async (password) => {
  const auth = await readAuthConfig();
  if (!auth?.enabled || !auth.passwordHash || !auth.salt) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  const candidate = await hashPassword(password, auth.salt);
  return constantEqual(candidate, auth.passwordHash);
};

export const createSession = async () => {
  await ensureLoaded();
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt });
  await writeSessions();
  return { token, expiresAt, maxAgeMs: SESSION_TTL_MS };
};

export const verifySession = async (token) => {
  if (typeof token !== 'string' || token.length === 0) return false;
  await ensureLoaded();
  const entry = sessions.get(token);
  if (!entry) return false;
  if (entry.expiresAt <= now()) {
    sessions.delete(token);
    await writeSessions().catch(() => null);
    return false;
  }
  return true;
};

export const revokeSession = async (token) => {
  await ensureLoaded();
  if (sessions.delete(token)) {
    await writeSessions();
  }
};

export const revokeAllSessions = async () => {
  await ensureLoaded();
  sessions.clear();
  await writeSessions();
};

// Parse the `Cookie` header for our token. Express doesn't ship a cookie
// parser and we only need one cookie name — manual parse keeps the dep tree
// small (CLAUDE.md "Default to writing code yourself").
export const parseCookieToken = (cookieHeader) => {
  if (typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
};

// Pull the token from a request — cookie first, then Authorization: Bearer.
// Bearer support lets curl/scripts authenticate without juggling cookies.
// Header names are lowercased by both Node's HTTP parser and Socket.IO's
// handshake — no uppercase fallback needed.
export const extractToken = (req) => {
  const cookie = parseCookieToken(req.headers?.cookie);
  if (cookie) return cookie;
  const authHeader = req.headers?.authorization;
  // RFC 6750: Bearer scheme name is case-insensitive.
  if (typeof authHeader === 'string' && authHeader.length > 7
      && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    return authHeader.slice(7).trim();
  }
  return null;
};

export const buildSessionCookie = (token, { secure = false } = {}) => {
  // HttpOnly so XSS can't read it; SameSite=Lax so cross-origin GETs from the
  // browser address bar work but cross-site POSTs are blocked. `Secure` is
  // toggled by the caller based on the loopback-mirror vs HTTPS scheme of the
  // request — a `Secure` cookie on a plain-http request is silently dropped.
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};

export const buildClearCookie = () =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
