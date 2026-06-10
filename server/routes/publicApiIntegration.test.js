/**
 * End-to-end integration: the REAL authGate middleware + the REAL voicePublic
 * router + the REAL voice router, wired against a temp data dir. Exercises the
 * full request path the plan's verification section describes:
 *   - auth OFF → public synth works
 *   - auth ON + exposed+passwordless → public synth works, config mutation 401s
 *   - auth ON + requireAuth → public synth 401s without a token, works with one
 * Only the TTS engine modules are mocked (so no ML models load); everything
 * else is the production code path.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-publicapi-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Mock only the TTS engine backends so synthesize()/listVoices() don't load
// Kokoro/Piper. The dispatcher (tts.js), config, and routes are all real.
vi.mock('../services/voice/tts-kokoro.js', () => ({
  synthesizeKokoro: vi.fn(async () => ({ wav: Buffer.from('RIFFkokoro'), latencyMs: 5 })),
  listKokoroVoices: vi.fn(async () => [{ name: 'af_heart' }]),
  readyState: vi.fn(() => 'lazy'),
  unloadKokoro: vi.fn(() => ({ unloaded: false })),
  loadedModelKey: vi.fn(() => null),
}));
vi.mock('../services/voice/tts-piper.js', () => ({
  synthesizePiper: vi.fn(async () => ({ wav: Buffer.from('RIFFpiper'), latencyMs: 7 })),
  listPiperVoices: vi.fn(async () => [{ name: 'en_GB-jenny_dioco-medium' }]),
}));

const resetSettings = (extra = {}) => {
  writeFileSync(join(tempRoot, 'settings.json'), JSON.stringify(extra, null, 2) + '\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};
const setApiAccess = (apiAccess) => {
  const raw = JSON.parse(readFileSync(join(tempRoot, 'settings.json'), 'utf-8'));
  raw.apiAccess = apiAccess;
  writeFileSync(join(tempRoot, 'settings.json'), JSON.stringify(raw, null, 2) + '\n');
};

const buildApp = async () => {
  const { authGate } = await import('../lib/authGate.js');
  const voicePublicRoutes = (await import('./voicePublic.js')).default;
  const voiceRoutes = (await import('./voice.js')).default;
  const app = express();
  app.use(express.json());
  app.use(authGate);
  app.set('io', { emit: () => {} });
  app.use('/api/voice/public', voicePublicRoutes);
  app.use('/api/voice', voiceRoutes);
  return app;
};

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});
afterAll(() => cleanup());

describe('public voice API — end-to-end through authGate', () => {
  it('auth OFF: public synthesize returns WAV', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
  });

  it('auth ON + exposed + passwordless: public synthesize works WITHOUT a token', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    setApiAccess({ voice: { exposed: true, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi', engine: 'piper' });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it('auth ON + exposed + passwordless: config mutation is STILL 401', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    setApiAccess({ voice: { exposed: true, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).put('/api/voice/config').send({ enabled: true });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('auth ON + requireAuth: public synthesize 401s without a token, works with one', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    setApiAccess({ voice: { exposed: true, requireAuth: true } });
    const app = await buildApp();

    const denied = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi' });
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .post('/api/voice/public/synthesize')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hi' });
    expect(allowed.status).toBe(200);
  });

  it('auth ON + not exposed: public synthesize 401s', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    setApiAccess({ voice: { exposed: false, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi' });
    expect(res.status).toBe(401);
  });
});
