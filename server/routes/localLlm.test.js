import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import localLlmRoutes from './localLlm.js';
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js';
import { localLlmCompareSchema, localLlmTestSchema } from '../lib/validation.js';

vi.mock('../services/localLlm.js', () => ({
  getStatus: vi.fn(),
  listModels: vi.fn(async () => []),
  installModel: vi.fn(),
  deleteModel: vi.fn(),
  switchBackend: vi.fn(),
  migrateBackend: vi.fn(),
  installBackend: vi.fn(),
  upgradeBackend: vi.fn(),
  controlOllamaServer: vi.fn(),
}));

vi.mock('../services/localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../services/ollamaManager.js', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadModel: vi.fn(),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.set('io', { emit: vi.fn() });
  app.use('/api/local-llm', localLlmRoutes);
  return app;
}

describe('local LLM playground routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a single local model test with validated defaults', async () => {
    runLocalLlmTest.mockResolvedValue({
      backend: 'ollama',
      modelId: 'llama3.2',
      text: 'hello',
      runId: 'run-1',
      timings: { totalMs: 25, ttftMs: 10, chars: 5, charsPerSecond: 200 },
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello');
    expect(runLocalLlmTest).toHaveBeenCalledWith({
      backend: 'ollama',
      modelId: 'llama3.2',
      prompt: 'Say hello',
      systemPrompt: '',
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 300000,
    });
  });

  it('compares models in the requested execution mode', async () => {
    compareLocalLlmModels.mockResolvedValue({
      mode: 'parallel',
      results: [
        { backend: 'ollama', modelId: 'a', text: 'A' },
        { backend: 'lmstudio', modelId: 'b', text: 'B' },
      ],
    });

    const targets = [
      { backend: 'ollama', modelId: 'a' },
      { backend: 'lmstudio', modelId: 'b' },
    ];
    const res = await request(makeApp())
      .post('/api/local-llm/compare')
      .send({ mode: 'parallel', targets, prompt: 'Compare this', options: { maxTokens: 64 } });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(compareLocalLlmModels).toHaveBeenCalledWith({
      mode: 'parallel',
      targets,
      prompt: 'Compare this',
      options: {
        systemPrompt: '',
        temperature: 0.3,
        maxTokens: 64,
        timeoutMs: 300000,
      },
    });
  });

  it('rejects empty prompts before running a model', () => {
    const parsed = localLlmTestSchema.safeParse({ backend: 'ollama', modelId: 'llama3.2', prompt: '   ' });

    expect(parsed.success).toBe(false);
  });

  it('limits comparisons to six targets', () => {
    const targets = Array.from({ length: 7 }, (_, i) => ({ backend: 'ollama', modelId: `model-${i}` }));
    const parsed = localLlmCompareSchema.safeParse({ targets, prompt: 'too many' });

    expect(parsed.success).toBe(false);
  });
});
