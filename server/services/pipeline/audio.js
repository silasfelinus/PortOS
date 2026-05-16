/**
 * Pipeline audio helpers — voice ID namespace + thin wrappers around the
 * existing voice-agent TTS (`server/services/voice/tts.js`) for pipeline
 * artifacts that need to land on disk instead of streaming over Socket.IO.
 *
 * Provider strategy: **always-available local OSS first.** Kokoro and Piper
 * ship in-process via ONNX/transformers.js — every install can render voice
 * lines without network or API keys. Premium providers (ElevenLabs, etc.)
 * add as sibling engines via `server/services/voice/tts.js`'s engine
 * dispatch; the pipeline doesn't care which one rendered the bytes.
 *
 * Voice ID namespace: `engine:voiceName` — `kokoro:af_heart`,
 * `piper:en_GB-northern_english_male`. A bare voice name without the
 * `engine:` prefix is interpreted as the active engine's voice.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { synthesize, listVoices, VALID_ENGINES } from '../voice/tts.js';
import { ServerError } from '../../lib/errorHandler.js';

const VOICE_ID_RE = /^([a-z][a-z0-9-]*):(.+)$/i;

/**
 * Split a voice id into `{ engine, voice }`. Returns `{ engine: null, voice: id }`
 * when no engine prefix is present so the caller can fall back to the active
 * engine — same shape as the legacy single-engine code path.
 */
export function parseVoiceId(voiceId) {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return { engine: null, voice: null };
  const trimmed = voiceId.trim();
  const m = trimmed.match(VOICE_ID_RE);
  if (!m) return { engine: null, voice: trimmed };
  const engine = m[1].toLowerCase();
  if (!VALID_ENGINES.has(engine)) return { engine: null, voice: trimmed };
  return { engine, voice: m[2] };
}

/**
 * List every voice exposed by every supported engine, namespaced with
 * `engine:voiceName` so the character voice picker can present a single
 * flat list across providers. Failures from one engine never block the
 * others — a missing Piper binary, for instance, just drops piper voices
 * from the list.
 */
export async function listAllVoices() {
  const engines = [...VALID_ENGINES];
  const results = await Promise.all(engines.map(async (engine) => {
    try {
      const { voices } = await listVoices(engine);
      return voices.map((v) => ({
        id: `${engine}:${v.name}`,
        engine,
        voice: v.name,
        label: v.label || v.name,
        // Carry through any metadata the engine surfaces (gender, language,
        // accent, etc.) without locking the shape — the UI renders what's
        // present.
        ...v,
      }));
    } catch (err) {
      console.warn(`⚠️ listAllVoices: ${engine} unavailable — ${err?.message || err}`);
      return [];
    }
  }));
  return results.flat();
}

/**
 * Synthesize text to a WAV file under PATHS.audio and return the saved
 * filename. The route layer + the audio stage line records correlate by
 * filename, same convention as the image pipeline.
 *
 * `voiceId` may be the namespaced form (`kokoro:af_heart`) or a bare voice
 * name (interpreted against the active engine). Empty / falsy `voiceId`
 * uses the configured default voice.
 */
export async function synthesizeToFile({ text, voiceId, signal } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new ServerError('text is required', { status: 400, code: 'PIPELINE_AUDIO_EMPTY_TEXT' });
  }
  const { engine, voice } = parseVoiceId(voiceId);
  const opts = { signal };
  if (engine) opts.engine = engine;
  if (voice) opts.voice = voice;

  const { wav, latencyMs, engine: usedEngine } = await synthesize(trimmed, opts);
  await ensureDir(PATHS.audio);
  // UUID filename keeps two simultaneous renders from colliding; the line's
  // audioJobId-or-audioFilename binding lives in stages.audio.lines[].
  const filename = `vo-${randomUUID()}.wav`;
  await writeFile(join(PATHS.audio, filename), wav);
  return { filename, latencyMs, engine: usedEngine, voiceId: voice ? `${usedEngine}:${voice}` : null };
}
