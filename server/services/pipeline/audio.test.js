import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-audio-test-${process.pid}-${Date.now()}`);
const FAKE_AUDIO_DIR = join(TEST_HOME, 'audio');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, audio: FAKE_AUDIO_DIR },
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const synthesizeMock = vi.fn();
const listVoicesMock = vi.fn();
vi.mock('../voice/tts.js', () => ({
  synthesize: (...a) => synthesizeMock(...a),
  listVoices: (...a) => listVoicesMock(...a),
  VALID_ENGINES: new Set(['kokoro', 'piper']),
}));

const { parseVoiceId, listAllVoices, synthesizeToFile } = await import('./audio.js');

beforeEach(async () => {
  synthesizeMock.mockReset();
  listVoicesMock.mockReset();
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('parseVoiceId', () => {
  it('splits engine:voice pairs', () => {
    expect(parseVoiceId('kokoro:af_heart')).toEqual({ engine: 'kokoro', voice: 'af_heart' });
    expect(parseVoiceId('piper:en_GB-northern_english_male')).toEqual({
      engine: 'piper', voice: 'en_GB-northern_english_male',
    });
  });

  it('ignores unknown engine prefixes and treats the whole id as a bare voice name', () => {
    expect(parseVoiceId('elevenlabs:Rachel')).toEqual({ engine: null, voice: 'elevenlabs:Rachel' });
  });

  it('treats unprefixed strings as a bare voice name', () => {
    expect(parseVoiceId('af_heart')).toEqual({ engine: null, voice: 'af_heart' });
  });

  it('returns nulls for empty / whitespace / non-string inputs', () => {
    expect(parseVoiceId('')).toEqual({ engine: null, voice: null });
    expect(parseVoiceId('   ')).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(null)).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(undefined)).toEqual({ engine: null, voice: null });
    expect(parseVoiceId(42)).toEqual({ engine: null, voice: null });
  });
});

describe('listAllVoices', () => {
  it('namespaces voices with engine: and merges across providers', async () => {
    listVoicesMock.mockImplementation(async (engine) => {
      if (engine === 'kokoro') return { engine, voices: [{ name: 'af_heart', label: 'Heart' }] };
      if (engine === 'piper') return { engine, voices: [{ name: 'en_GB-northern_english_male' }] };
      return { engine, voices: [] };
    });
    const voices = await listAllVoices();
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart',
    }));
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'piper:en_GB-northern_english_male', engine: 'piper',
    }));
  });

  it('falls back gracefully when one engine throws', async () => {
    listVoicesMock.mockImplementation(async (engine) => {
      if (engine === 'kokoro') return { engine, voices: [{ name: 'af_heart' }] };
      throw new Error('piper unavailable');
    });
    const voices = await listAllVoices();
    expect(voices.length).toBe(1);
    expect(voices[0].engine).toBe('kokoro');
  });
});

describe('synthesizeToFile', () => {
  it('rejects empty text with 400', async () => {
    await expect(synthesizeToFile({ text: '  ', voiceId: 'kokoro:af_heart' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('writes the rendered WAV to PATHS.audio and returns the filename', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('FAKE-WAV-BYTES'), latencyMs: 123, engine: 'kokoro' });
    const result = await synthesizeToFile({ text: 'hello there', voiceId: 'kokoro:af_heart' });
    expect(result.filename).toMatch(/^vo-.*\.wav$/);
    expect(result.engine).toBe('kokoro');
    expect(result.latencyMs).toBe(123);
    const written = await readFile(join(FAKE_AUDIO_DIR, result.filename));
    expect(written.toString()).toBe('FAKE-WAV-BYTES');
  });

  it('passes engine + voice through to synthesize() when the id is namespaced', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('w'), latencyMs: 1, engine: 'piper' });
    await synthesizeToFile({ text: 'hi', voiceId: 'piper:en_GB-northern_english_male' });
    expect(synthesizeMock).toHaveBeenCalledWith('hi', expect.objectContaining({
      engine: 'piper',
      voice: 'en_GB-northern_english_male',
    }));
  });

  it('omits engine/voice when no voiceId is supplied (lets the configured default apply)', async () => {
    synthesizeMock.mockResolvedValue({ wav: Buffer.from('w'), latencyMs: 1, engine: 'kokoro' });
    await synthesizeToFile({ text: 'hi' });
    const passed = synthesizeMock.mock.calls.at(-1)[1];
    expect(passed).not.toHaveProperty('engine');
    expect(passed).not.toHaveProperty('voice');
  });
});
