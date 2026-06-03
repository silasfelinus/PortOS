import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from './mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-authgate-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});

afterAll(() => {
  cleanup();
});

const runGate = async (gate, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    type(value) { this.headers['Content-Type'] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; resolve({ res, called: false }); return this; },
    send(payload) { this.body = payload; resolve({ res, called: false }); return this; },
  };
  gate(req, res, () => resolve({ res, called: true }));
});

describe('authGate middleware', () => {
  it('is a no-op when auth is disabled', async () => {
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(true);
  });

  it('passes /api/auth/login through even when auth is enabled', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/auth/login', headers: {} });
    expect(result.called).toBe(true);
  });

  it('blocks /api routes with no token', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  });

  it('allows /api routes when the cookie token is valid', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { cookie: `portos_auth=${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('allows /api routes when the Authorization Bearer token is valid', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('lets static client paths through when auth is on', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/assets/index.js', headers: {} });
    expect(result.called).toBe(true);
  });

  it('returns plain-text 401 for blocked /data/* asset requests', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/data/images/foo.png', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toBe('Unauthorized');
  });
});

describe('socketAuthGate middleware', () => {
  it('is a no-op when auth is disabled', async () => {
    const { socketAuthGate } = await import('./authGate.js');
    const result = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (err) => resolve(err));
    });
    expect(result).toBeUndefined();
  });

  it('rejects an unauthenticated handshake when auth is on', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it('accepts a handshake with a valid cookie', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: { cookie: `portos_auth=${token}` } } }, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
  });
});
