/**
 * Boundary tests for the catalog bulk-import parsers. Pure — no DB, no LLM.
 *
 * Each parser is exercised on a happy-path payload + at least one structural
 * failure mode. Per-entry Zod validation happens at the route boundary; this
 * suite only asserts that the parser produces the normalized
 * `{ type, name, payload, tags }` shape (or throws on structurally invalid
 * input).
 */

import { describe, it, expect } from 'vitest';
import {
  parseJsonBulk,
  parseCsvBulk,
  parseMarkdownBulk,
  parseBulkPayload,
  PRIMARY_CONTENT_KEY_BY_TYPE,
  ingredientToMarkdown,
  bundleToMarkdown,
  toYamlString,
} from './catalogBulkParsers.js';

describe('PRIMARY_CONTENT_KEY_BY_TYPE', () => {
  it('mirrors the client-side map for the six v1 types', () => {
    expect(PRIMARY_CONTENT_KEY_BY_TYPE).toEqual({
      character: 'physicalDescription',
      place: 'description',
      object: 'description',
      idea: 'summary',
      scene: 'summary',
      concept: 'summary',
    });
  });
});

describe('parseJsonBulk', () => {
  it('parses an array of well-formed entries and lands description in the type primary key', () => {
    const out = parseJsonBulk(JSON.stringify([
      { type: 'character', name: 'Alice', description: 'a curious sleuth', tags: ['noir'] },
      { type: 'place', name: 'The Hollow', description: 'abandoned subway tunnel' },
    ]));
    expect(out).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'a curious sleuth' }, tags: ['noir'] },
      { type: 'place', name: 'The Hollow', payload: { description: 'abandoned subway tunnel' }, tags: [] },
    ]);
  });

  it('preserves explicit payload keys over the description shortcut', () => {
    const out = parseJsonBulk(JSON.stringify([
      { type: 'character', name: 'Bob', description: 'shortcut', payload: { physicalDescription: 'explicit wins' } },
    ]));
    expect(out[0].payload.physicalDescription).toBe('explicit wins');
  });

  it('throws on non-array root', () => {
    expect(() => parseJsonBulk(JSON.stringify({ type: 'character', name: 'X' }))).toThrow(/array/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonBulk('{not json}')).toThrow(/invalid JSON/);
  });

  it('throws on unknown ingredient type', () => {
    expect(() => parseJsonBulk(JSON.stringify([{ type: 'faction', name: 'X' }]))).toThrow(/invalid or missing type/);
  });

  it('throws on missing name', () => {
    expect(() => parseJsonBulk(JSON.stringify([{ type: 'idea', name: '   ' }]))).toThrow(/name is required/);
  });
});

describe('parseCsvBulk', () => {
  it('parses the documented header + data rows', () => {
    const csv = [
      'type,name,description,tags',
      'character,Alice,A curious sleuth,"noir, gritty"',
      'place,The Hollow,Abandoned subway tunnel,',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'A curious sleuth' }, tags: ['noir', 'gritty'] },
      { type: 'place', name: 'The Hollow', payload: { description: 'Abandoned subway tunnel' }, tags: [] },
    ]);
  });

  it('folds unknown columns into payload (canon shape pass-through)', () => {
    const csv = [
      'type,name,personality,role',
      'character,Alice,curious,detective',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out[0].payload).toEqual({ personality: 'curious', role: 'detective' });
  });

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const csv = [
      'type,name,description',
      'idea,X,"comma, inside and ""quotes"" too"',
    ].join('\n');
    const out = parseCsvBulk(csv);
    expect(out[0].payload.summary).toBe('comma, inside and "quotes" too');
  });

  it('throws when required headers are missing', () => {
    expect(() => parseCsvBulk('foo,bar\nx,y')).toThrow(/headers must include/);
  });

  it('throws when there is no data row', () => {
    expect(() => parseCsvBulk('type,name')).toThrow(/header row and at least one/);
  });

  it('skips blank lines between data rows', () => {
    const csv = ['type,name', 'idea,A', '', 'idea,B', ''].join('\n');
    const out = parseCsvBulk(csv);
    expect(out.map((e) => e.name)).toEqual(['A', 'B']);
  });
});

describe('parseMarkdownBulk', () => {
  it('parses sections, body, and tags', () => {
    const md = [
      '## Character: Alice',
      'A curious sleuth.',
      'She walks at night.',
      'tags: noir, gritty',
      '',
      '## Place: The Hollow',
      'Abandoned subway tunnel.',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out).toEqual([
      {
        type: 'character',
        name: 'Alice',
        payload: { physicalDescription: 'A curious sleuth.\nShe walks at night.' },
        tags: ['noir', 'gritty'],
      },
      {
        type: 'place',
        name: 'The Hollow',
        payload: { description: 'Abandoned subway tunnel.' },
        tags: [],
      },
    ]);
  });

  it('ignores unrecognized type headings (drops their body)', () => {
    const md = [
      '## Faction: Goons',
      'a body we ignore',
      '## Scene: Rooftop chase',
      'jumped across two buildings',
    ].join('\n');
    const out = parseMarkdownBulk(md);
    expect(out).toEqual([
      { type: 'scene', name: 'Rooftop chase', payload: { summary: 'jumped across two buildings' }, tags: [] },
    ]);
  });

  it('throws when no `## <Type>: <Name>` section is found', () => {
    expect(() => parseMarkdownBulk('Just a paragraph.\nNo heading here.')).toThrow(/zero `## <Type>: <Name>`/);
  });

  it('handles CRLF line endings', () => {
    const md = '## Idea: X\r\ndescribed here\r\ntags: a, b\r\n';
    const out = parseMarkdownBulk(md);
    expect(out[0]).toEqual({ type: 'idea', name: 'X', payload: { summary: 'described here' }, tags: ['a', 'b'] });
  });

  it('is case-insensitive on the type token', () => {
    const md = '## CHARACTER: X\nbody\n';
    const out = parseMarkdownBulk(md);
    expect(out[0].type).toBe('character');
  });
});

describe('parseBulkPayload dispatch', () => {
  it('routes to the right parser by format name', () => {
    expect(parseBulkPayload('json', '[{"type":"idea","name":"X"}]')[0].name).toBe('X');
    expect(parseBulkPayload('csv', 'type,name\nidea,X')[0].name).toBe('X');
    expect(parseBulkPayload('markdown', '## Idea: X\nbody\n')[0].name).toBe('X');
  });

  it('throws on unknown format', () => {
    expect(() => parseBulkPayload('toml', 'x')).toThrow(/unknown bulk-import format/);
  });
});

describe('ingredientToMarkdown / bundleToMarkdown', () => {
  it('emits a Type: Name heading + body + tags + scraps', () => {
    const md = ingredientToMarkdown({
      type: 'character',
      name: 'Alice',
      payload: { physicalDescription: 'a curious sleuth', personality: 'quiet' },
      tags: ['noir'],
      scraps: [{ sourceKind: 'paste', rawText: 'first sighting in chapter 1' }],
    });
    expect(md).toContain('## Character: Alice');
    expect(md).toContain('a curious sleuth');
    expect(md).toContain('tags: noir');
    expect(md).toContain('"personality": "quiet"');
    expect(md).toContain('### Scraps');
    expect(md).toContain('first sighting in chapter 1');
  });

  it('round-trips type/name/body via the markdown parser', () => {
    const bundle = {
      ref: { kind: 'universe', id: 'u1' },
      exportedAt: '2026-05-29T00:00:00.000Z',
      ingredients: [
        { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, tags: ['noir'], scraps: [] },
        { type: 'idea', name: 'time loop', payload: { summary: 'recurs every Tuesday' }, tags: [], scraps: [] },
      ],
    };
    const md = bundleToMarkdown(bundle);
    const reparsed = parseMarkdownBulk(md);
    expect(reparsed).toEqual([
      { type: 'character', name: 'Alice', payload: { physicalDescription: 'curious' }, tags: ['noir'] },
      { type: 'idea', name: 'time loop', payload: { summary: 'recurs every Tuesday' }, tags: [] },
    ]);
  });
});

describe('toYamlString', () => {
  it('emits a parseable subset for the export bundle shape', () => {
    const yaml = toYamlString({
      version: 1,
      ref: { kind: 'universe', id: 'u1' },
      ingredients: [
        { id: 'cat-chr-1', type: 'character', name: 'Alice', tags: ['noir'], payload: { physicalDescription: 'curious' } },
      ],
    });
    expect(yaml).toMatch(/^version: 1\n/);
    expect(yaml).toContain('ref:\n');
    expect(yaml).toContain('kind: "universe"');
    expect(yaml).toContain('- id: "cat-chr-1"');
    expect(yaml).toContain('tags:\n');
    expect(yaml).toContain('- "noir"');
  });

  it('handles null / boolean / numeric scalars', () => {
    const yaml = toYamlString({ a: null, b: true, c: 42 });
    expect(yaml).toContain('a: null');
    expect(yaml).toContain('b: true');
    expect(yaml).toContain('c: 42');
  });

  it('emits empty array / object as the inline form', () => {
    const yaml = toYamlString({ tags: [], payload: {} });
    expect(yaml).toContain('tags: []');
    expect(yaml).toContain('payload: {}');
  });
});
