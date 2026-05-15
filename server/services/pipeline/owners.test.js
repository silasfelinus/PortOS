import { describe, it, expect } from 'vitest';
import { buildComicPagesOwner, parseComicPagesOwner } from './owners.js';

describe('pipeline owner strings', () => {
  it('round-trips a cover owner', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-abc', target: 'cover' });
    expect(owner).toBe('pipeline:iss-abc:comicPages:cover');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-abc', target: 'cover' });
  });

  it('round-trips a page owner', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-xyz', target: 'page', pageIndex: 7 });
    expect(owner).toBe('pipeline:iss-xyz:comicPages:page7');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-xyz', target: 'page', pageIndex: 7 });
  });

  it('builder throws on unknown target', () => {
    expect(() => buildComicPagesOwner({ issueId: 'iss-1', target: 'panel' })).toThrow();
  });

  it('parser returns null for unmatched strings', () => {
    expect(parseComicPagesOwner(null)).toBeNull();
    expect(parseComicPagesOwner('')).toBeNull();
    expect(parseComicPagesOwner('not-a-pipeline-owner')).toBeNull();
    expect(parseComicPagesOwner('pipeline:iss:storyboards:scene0')).toBeNull();
    expect(parseComicPagesOwner('pipeline:iss:comicPages:pageNaN')).toBeNull();
  });
});
