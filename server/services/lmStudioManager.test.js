import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

let tempDir;
let originalModelsDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portos-lms-models-'));
  originalModelsDir = process.env.LM_STUDIO_MODELS_DIR;
  process.env.LM_STUDIO_MODELS_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  if (originalModelsDir === undefined) delete process.env.LM_STUDIO_MODELS_DIR;
  else process.env.LM_STUDIO_MODELS_DIR = originalModelsDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const writeFile = (rel, content = 'gguf') => {
  const full = path.join(tempDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};

describe('lmStudioManager local model resolution', () => {
  it('resolves a model when the API id maps directly to the repo folder', async () => {
    const gguf = writeFile('lmstudio-community/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf');
    const { resolveLocalModel } = await import('./lmStudioManager.js');

    const resolved = await resolveLocalModel('lmstudio-community/gpt-oss-20b-GGUF');

    expect(resolved).toMatchObject({
      ggufPath: gguf,
      projectorPath: null,
      isMlx: false,
      isSharded: false
    });
  });

  it('falls back to a normalized repo scan when LM Studio reports a different API id', async () => {
    const gguf = writeFile('lmstudio-community/gpt-oss-20b-GGUF/gpt-oss-20b-MXFP4.gguf');
    const { resolveLocalModel } = await import('./lmStudioManager.js');

    const resolved = await resolveLocalModel('openai/gpt-oss-20b');

    expect(resolved).toMatchObject({
      ggufPath: gguf,
      projectorPath: null,
      isMlx: false,
      isSharded: false
    });
  });
});
