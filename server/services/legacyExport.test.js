import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import {
  redactSecrets,
  buildBundleFiles,
  buildManifest,
  buildLegacyZip,
  previewLegacyExport,
  getSectionKeys,
} from './legacyExport.js';
import { parseZip } from '../lib/zipStream.js';

// Round-trip a zip Buffer through the production parser → { path: Buffer }.
function unzip(zipBuf) {
  return new Promise((resolve, reject) => {
    const entryPromises = [];
    const parser = parseZip();
    parser.on('entry', (entry) => {
      entryPromises.push(new Promise((res) => {
        const chunks = [];
        const sink = new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } });
        sink.on('finish', () => res({ path: entry.path, data: Buffer.concat(chunks) }));
        entry.pipe(sink);
      }));
    });
    parser.on('close', () => Promise.all(entryPromises).then(
      (entries) => resolve(Object.fromEntries(entries.map(e => [e.path, e.data]))),
      reject,
    ));
    parser.on('error', reject);
    Readable.from([zipBuf]).pipe(parser);
  });
}

// A representative gathered-data object — exercises every section.
function sampleData() {
  return {
    twinPrompt: '# Twin\nYou are helping someone.',
    claudeMd: '# Soul\n',
    stories: [{ id: 's1', themeId: 'childhood', prompt: 'Earliest memory?', content: 'A summer.', createdAt: '2020-01-01' }],
    genome: { uploaded: true, snpCount: 600000, markerCount: 42 },
    taste: { sections: [{ label: 'Music', status: 'complete', summary: 'Loves jazz.' }] },
    chronotype: { type: 'Lion', confidence: 0.8 },
    longevity: { estimatedLifeExpectancy: 90 },
    traits: { dimensions: { openness: { score: 80, label: 'High' } }, summary: 'Curious.' },
    brain: {
      people: [{ id: 'p1', name: 'Ada', content: 'A friend.' }],
      projects: [{ id: 'pr1', title: 'PortOS', content: 'Personal OS.', tags: ['code'] }],
      ideas: [], journals: [{ id: 'j1', title: 'Day 1', content: 'Started.' }], links: [],
    },
    memories: [{ id: 'm1', category: 'work', summary: 'Shipped a feature.' }],
    goals: [{ id: 'g1', title: 'Write a book', status: 'active', progress: 30, description: 'A novel.',
      milestones: [{ id: 'ms1', title: 'Outline', completedAt: '2024-05-01T00:00:00Z' }] }],
    health: { resting_heart_rate: { value: 58, date: '2026-06-10' } },
  };
}

describe('redactSecrets', () => {
  it('masks an OpenAI-style key', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrstuvwxyz012345')).toContain('[REDACTED]');
  });
  it('masks a GitHub PAT', () => {
    expect(redactSecrets('ghp_0123456789abcdefghijklmnopqrstuvwx')).toBe('[REDACTED]');
  });
  it('masks a password assignment', () => {
    expect(redactSecrets('"password": "hunter2hunter2"')).toContain('[REDACTED]');
    expect(redactSecrets('"password": "hunter2hunter2"')).not.toContain('hunter2');
  });
  it('leaves ordinary prose untouched', () => {
    const prose = 'I grew up near the ocean and loved skateboarding.';
    expect(redactSecrets(prose)).toBe(prose);
  });
  it('passes through non-strings', () => {
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
  });
});

describe('buildBundleFiles', () => {
  it('includes every present section with no filter', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const names = files.map(f => f.name);
    expect(names).toContain('identity/digital-twin-prompt.md');
    expect(names).toContain('autobiography/autobiography.md');
    expect(names).toContain('brain/people.md');
    expect(names).toContain('brain/memories.md');
    expect(names).toContain('goals/goals.md');
    expect(names).toContain('decisions/key-decisions.md');
    expect(names).toContain('health/health-summary.md');
    expect(sections.health.present).toBe(true);
    expect(sections.brain.memories).toBe(1);
  });

  it('honors a section filter', () => {
    const { files, sections } = buildBundleFiles(sampleData(), { sections: ['goals'] });
    const names = files.map(f => f.name);
    expect(names).toContain('goals/goals.md');
    expect(names.some(n => n.startsWith('autobiography/'))).toBe(false);
    // present is still reported true even when excluded from this bundle
    expect(sections.autobiography.present).toBe(true);
    expect(sections.autobiography.included).toBe(false);
    expect(sections.goals.included).toBe(true);
  });

  it('marks absent sections present:false and emits no files for them', () => {
    const empty = { twinPrompt: '', claudeMd: '', stories: [], genome: { uploaded: false },
      taste: { sections: [] }, chronotype: null, longevity: null, traits: null,
      brain: { people: [], projects: [], ideas: [], journals: [], links: [] },
      memories: [], goals: [], health: {} };
    const { files, sections } = buildBundleFiles(empty);
    expect(sections.autobiography.present).toBe(false);
    expect(sections.health.present).toBe(false);
    expect(files.some(f => f.name.startsWith('autobiography/'))).toBe(false);
  });

  it('redacts secrets pasted into brain content', () => {
    const d = sampleData();
    d.brain.journals[0].content = 'token ghp_0123456789abcdefghijklmnopqrstuvwx end';
    const { files } = buildBundleFiles(d);
    const journal = files.find(f => f.name === 'brain/journals.md');
    expect(journal.data.toString()).toContain('[REDACTED]');
    expect(journal.data.toString()).not.toContain('ghp_0123');
  });

  it('includes a health source caveat', () => {
    const { files } = buildBundleFiles(sampleData());
    const health = files.find(f => f.name === 'health/health-summary.md');
    expect(health.data.toString()).toMatch(/not a verified medical record/i);
    expect(health.data.toString()).toContain('last sync 2026-06-10');
  });
});

describe('buildManifest', () => {
  it('hashes every file with a SHA-256 and stamps kind/schemaVersion', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const manifest = buildManifest(files, { sections, portosVersion: '1.2.3', generatedAt: '2026-06-18T00:00:00Z' });
    expect(manifest.kind).toBe('portos-legacy-export');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fileCount).toBe(files.length);
    for (const name of Object.keys(manifest.files)) {
      expect(manifest.files[name]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('buildLegacyZip', () => {
  it('produces a valid zip that unzips to README + manifest + section files', async () => {
    // gatherLegacyData runs against the live (test) backends; each source is
    // catch-guarded, so the bundle is built regardless of what data exists.
    const { buffer, manifest } = await buildLegacyZip({});
    const entries = await unzip(buffer);
    expect(entries['README.md'].toString()).toMatch(/Privacy notice/);
    expect(entries['manifest.json']).toBeDefined();
    const parsed = JSON.parse(entries['manifest.json'].toString());
    expect(parsed.kind).toBe('portos-legacy-export');
    expect(parsed.fileCount).toBe(manifest.fileCount);
    // Every manifest-listed file (except manifest.json itself) is in the zip.
    for (const name of Object.keys(parsed.files)) {
      expect(entries[name]).toBeDefined();
    }
  });

  it('emits legacy-export socket events when io is provided', async () => {
    const events = [];
    const io = { emit: (e, p) => events.push([e, p]) };
    await buildLegacyZip({ io });
    expect(events.map(e => e[0])).toEqual(
      expect.arrayContaining(['legacy-export:started', 'legacy-export:progress', 'legacy-export:completed']),
    );
  });
});

describe('previewLegacyExport', () => {
  it('returns section metadata and an estimated size without throwing', async () => {
    const preview = await previewLegacyExport();
    expect(preview).toHaveProperty('sections');
    expect(typeof preview.estimatedBytes).toBe('number');
    expect(preview.fileCount).toBeGreaterThanOrEqual(2); // README + manifest at minimum
  });
});

describe('getSectionKeys', () => {
  it('lists the known sections', () => {
    expect(getSectionKeys()).toEqual(['identity', 'autobiography', 'brain', 'goals', 'decisions', 'health']);
  });
});
