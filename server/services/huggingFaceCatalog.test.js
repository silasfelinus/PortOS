import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchHuggingFaceModels } from './huggingFaceCatalog.js'

const response = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: vi.fn(async () => body),
  text: vi.fn(async () => JSON.stringify(body))
})

describe('huggingFaceCatalog', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps GGUF search results to Ollama hf.co install ids with preferred quants', async () => {
    fetch.mockResolvedValue(response([
      {
        modelId: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        downloads: 100000,
        likes: 1000,
        tags: ['gguf', 'qwen', 'image-text-to-text', 'license:apache-2.0'],
        lastModified: new Date().toISOString(),
        siblings: [
          { rfilename: 'Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf', size: 13_000_000_000 },
          { rfilename: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', size: 24_000_000_000 }
        ]
      }
    ]))

    const results = await searchHuggingFaceModels({
      backend: 'ollama',
      query: 'qwen3.6',
      category: 'coding',
      installedIds: []
    })

    expect(results[0]).toMatchObject({
      id: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M',
      repository: 'unsloth/Qwen3.6-35B-A3B-GGUF',
      category: 'coding',
      source: 'huggingface',
      quant: 'UD-Q4_K_M',
      license: 'apache-2.0'
    })
    expect(results[0].capabilities).toEqual(expect.arrayContaining(['chat', 'code']))
    expect(results[0].installable).toBe(true)
  })

  it('returns LM Studio repo ids and marks installed repos', async () => {
    fetch.mockResolvedValue(response([
      {
        id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
        downloads: 10,
        likes: 2,
        tags: ['gguf'],
        siblings: [{ rfilename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', size: 4_700_000_000 }]
      }
    ]))

    const results = await searchHuggingFaceModels({
      backend: 'lmstudio',
      query: 'llama',
      installedIds: ['bartowski/Meta-Llama-3.1-8B-Instruct-GGUF']
    })

    expect(results[0].id).toBe('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF')
    expect(results[0].installed).toBe(true)
  })

  it('backfills file sizes from the per-model blobs endpoint when the search omits them', async () => {
    fetch
      .mockResolvedValueOnce(response([
        {
          modelId: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
          downloads: 50,
          tags: ['gguf'],
          siblings: [{ rfilename: 'nomic-embed-text-v1.5.Q4_K_M.gguf' }] // search returns no size
        }
      ]))
      .mockResolvedValueOnce(response({
        id: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
        siblings: [{ rfilename: 'nomic-embed-text-v1.5.Q4_K_M.gguf', size: 84_106_624 }]
      }))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'nomic-embed' })

    expect(results[0].sizeBytes).toBe(84_106_624)
    expect(results[0].size).toMatch(/\d+(\.\d+)?\s(MB|GB)/)
  })

  it('filters out non-GGUF results even if Hugging Face returns them', async () => {
    fetch.mockResolvedValue(response([
      { modelId: 'org/Plain-Safetensors', tags: ['safetensors'], siblings: [] },
      { modelId: 'org/Useful-GGUF', tags: [], siblings: [{ rfilename: 'Useful-Q4_K_M.gguf' }] }
    ]))

    const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'useful' })

    expect(results.map((r) => r.repository)).toEqual(['org/Useful-GGUF'])
  })

  describe('audio category', () => {
    it('surfaces non-GGUF audio models (relaxes the GGUF filter) and infers the engine', async () => {
      fetch.mockResolvedValue(response([
        {
          modelId: 'facebook/musicgen-large',
          downloads: 500000,
          likes: 2000,
          tags: ['text-to-audio', 'musicgen', 'safetensors'],
          pipeline_tag: 'text-to-audio',
          siblings: [{ rfilename: 'model.safetensors', size: 13_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'musicgen', category: 'audio' })
      const musicgen = results.find((r) => r.repository === 'facebook/musicgen-large')

      expect(musicgen).toBeTruthy()
      expect(musicgen.category).toBe('audio')
      expect(musicgen.capabilities).toEqual(['audio'])
      expect(musicgen.engine).toBe('musicgen')
      // MusicGen threads --model into from_pretrained → custom checkpoints work.
      expect(musicgen.installable).toBe(true)
      // The Ollama install id is never used for audio — it's the bare repo id.
      expect(musicgen.id).toBe('facebook/musicgen-large')
    })

    it('always leads with curated suggestions (ACE-Step / Magenta / Stable Audio)', async () => {
      fetch.mockResolvedValue(response([]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', category: 'audio' })
      const byRepo = Object.fromEntries(results.map((r) => [r.repository, r]))

      // ACE-Step uses a fixed checkpoint (customModels: false) → Visit-only.
      expect(byRepo['ACE-Step/acestep-v15-xl-base']).toMatchObject({ category: 'audio', engine: 'acestep', installable: false, suggested: true })
      // No PortOS runtime yet → not installable.
      expect(byRepo['google/magenta-realtime-2']).toMatchObject({ engine: null, installable: false, suggested: true })
      // Gated behind a data-sharing agreement.
      expect(byRepo['stabilityai/stable-audio-3-medium']).toMatchObject({ gated: true, installable: false })
      expect(byRepo['stabilityai/stable-audio-3-medium'].note).toMatch(/data-sharing agreement/i)
    })

    it('drops non-audio results from a non-audio query (no GGUF, but audio-only)', async () => {
      // category=audio relaxes the GGUF filter — but a query like "llama" must
      // not surface unrelated chat models mislabeled as audio. Only the curated
      // suggestions (which match the query? none here) should remain.
      fetch.mockResolvedValue(response([
        {
          modelId: 'meta-llama/Llama-3.1-8B-Instruct',
          downloads: 999999,
          tags: ['text-generation', 'safetensors'],
          pipeline_tag: 'text-generation',
          siblings: [{ rfilename: 'model.safetensors', size: 8_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({ backend: 'ollama', query: 'llama', category: 'audio' })
      expect(results.find((r) => r.repository === 'meta-llama/Llama-3.1-8B-Instruct')).toBeUndefined()
    })

    it('marks an audio model installed when it is in the shared registry', async () => {
      fetch.mockResolvedValue(response([
        {
          modelId: 'facebook/musicgen-small',
          downloads: 100,
          tags: ['text-to-audio'],
          pipeline_tag: 'text-to-audio',
          siblings: [{ rfilename: 'model.safetensors', size: 2_000_000_000 }]
        }
      ]))

      const results = await searchHuggingFaceModels({
        backend: 'ollama',
        query: 'musicgen-small',
        category: 'audio',
        installedAudioRepos: ['facebook/musicgen-small']
      })
      const small = results.find((r) => r.repository === 'facebook/musicgen-small')
      expect(small.installed).toBe(true)
    })
  })
})
