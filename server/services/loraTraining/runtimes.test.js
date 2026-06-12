import { describe, it, expect } from 'vitest';
import {
  TRAINING_DEFAULTS,
  buildFlux2TrainArgs,
  buildMfluxTrainArgs,
  buildMfluxTrainConfig,
  resolveTrainingRuntime,
  runnerFamilyForRuntime,
} from './runtimes.js';

const MODELS = [
  { id: 'dev', name: 'Flux 1 Dev' },
  { id: 'schnell', name: 'Flux 1 Schnell' },
  { id: 'flux2-klein-4b', runner: 'flux2', repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic' },
  { id: 'flux2-klein-9b-bf16', runner: 'flux2', repo: 'black-forest-labs/FLUX.2-klein-9B' },
  { id: 'z-image-turbo', runner: 'z-image', repo: 'Tongyi/Z-Image-Turbo' },
];

describe('resolveTrainingRuntime', () => {
  it('routes dev to mflux', () => {
    const out = resolveTrainingRuntime('dev', MODELS);
    expect(out.runtime).toBe('mflux');
    expect(out.trainRepo).toBeNull();
  });

  it('routes flux2 models to the bf16 train repo for their variant', () => {
    expect(resolveTrainingRuntime('flux2-klein-4b', MODELS).trainRepo)
      .toBe('black-forest-labs/FLUX.2-klein-4B');
    expect(resolveTrainingRuntime('flux2-klein-9b-bf16', MODELS).trainRepo)
      .toBe('black-forest-labs/FLUX.2-klein-9B');
  });

  it('rejects schnell, diffusers families, and unknown ids', () => {
    expect(() => resolveTrainingRuntime('schnell', MODELS)).toThrow(/training supports/);
    expect(() => resolveTrainingRuntime('z-image-turbo', MODELS)).toThrow(/training supports/);
    expect(() => resolveTrainingRuntime('ghost', MODELS)).toThrow(/Unknown image model/);
  });

  it('maps runtimes to runner families', () => {
    expect(runnerFamilyForRuntime('mflux')).toBe('mflux');
    expect(runnerFamilyForRuntime('flux2')).toBe('flux2');
  });
});

describe('buildMfluxTrainConfig', () => {
  const base = {
    triggerWord: 'kessa',
    datasetImagesDir: '/data/lora-datasets/ds1/images',
    checkpointsDir: '/data/training-runs/r1/checkpoints',
    manifestImages: [
      { file: 'a.png', caption: 'kessa, front view' },
      { file: 'b.png', caption: 'kessa, side view' },
    ],
  };

  it('translates the step budget into epochs over the example set', () => {
    const config = buildMfluxTrainConfig({ ...base, params: { steps: 100 } });
    expect(config.training_loop.num_epochs).toBe(50); // 100 steps / 2 images
    expect(config.examples.images).toEqual([
      { image: 'a.png', prompt: 'kessa, front view' },
      { image: 'b.png', prompt: 'kessa, side view' },
    ]);
  });

  it('applies defaults and per-run params', () => {
    const config = buildMfluxTrainConfig({ ...base, params: { rank: 8, learningRate: 0.0002, resolution: 768 } });
    expect(config.lora_layers.transformer_blocks.lora_rank).toBe(8);
    expect(config.optimizer.learning_rate).toBe(0.0002);
    expect(config.width).toBe(768);
    expect(config.model).toBe('dev');
    expect(config.save.checkpoint_frequency).toBe(TRAINING_DEFAULTS.checkpointEvery);
  });

  it('disables checkpoint/sample frequency at 0', () => {
    const config = buildMfluxTrainConfig({ ...base, params: { steps: 200, checkpointEvery: 0, sampleEvery: 0 } });
    expect(config.save.checkpoint_frequency).toBe(200); // only the final save
    expect(config.instrumentation.generate_image_frequency).toBe(0);
  });

  it('throws on an empty example set', () => {
    expect(() => buildMfluxTrainConfig({ ...base, manifestImages: [] })).toThrow(/at least one/);
  });
});

describe('buildMfluxTrainArgs / buildFlux2TrainArgs', () => {
  it('builds the wrapper argv', () => {
    const args = buildMfluxTrainArgs({
      scriptPath: '/x/train_mflux_lora.py', configPath: '/r/cfg.json', runDir: '/r', totalSteps: 500,
    });
    expect(args).toEqual([
      '/x/train_mflux_lora.py', '--train-config', '/r/cfg.json',
      '--output-dir', '/r', '--total-steps', '500',
    ]);
  });

  it('builds the flux2 argv with merged params', () => {
    const args = buildFlux2TrainArgs({
      scriptPath: '/x/train_flux2_lora.py',
      trainRepo: 'black-forest-labs/FLUX.2-klein-4B',
      manifestPath: '/r/manifest.json',
      runDir: '/r',
      triggerWord: 'kessa',
      params: { steps: 20, rank: 4 },
    });
    expect(args).toContain('--model-repo');
    expect(args[args.indexOf('--steps') + 1]).toBe('20');
    expect(args[args.indexOf('--rank') + 1]).toBe('4');
    expect(args[args.indexOf('--lr') + 1]).toBe(String(TRAINING_DEFAULTS.learningRate));
    expect(args[args.indexOf('--sample-prompt') + 1]).toContain('kessa');
  });

  it('refuses non-bf16 train repos', () => {
    expect(() => buildFlux2TrainArgs({
      scriptPath: '/x.py', trainRepo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
      manifestPath: '/m.json', runDir: '/r', triggerWord: 'kessa',
    })).toThrow(/bf16/);
  });
});
