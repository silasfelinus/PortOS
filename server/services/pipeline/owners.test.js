import { describe, it, expect } from 'vitest';
import {
  buildComicPagesOwner, parseComicPagesOwner,
  buildStoryboardsShotOwner, parseStoryboardsShotOwner,
} from './owners.js';

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

  it('round-trips a storyboards shot owner', () => {
    const owner = buildStoryboardsShotOwner({ issueId: 'iss-789', sceneIndex: 2, shotIndex: 5 });
    expect(owner).toBe('pipeline:iss-789:storyboards:scene2:shot5');
    expect(parseStoryboardsShotOwner(owner)).toEqual({ issueId: 'iss-789', sceneIndex: 2, shotIndex: 5 });
  });

  it('shot parser rejects non-shot owners and malformed indices', () => {
    expect(parseStoryboardsShotOwner(null)).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:comicPages:cover')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:storyboards:scene0')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:storyboards:scene1:shotNaN')).toBeNull();
  });

  it('comic parser does not match shot owners and vice versa', () => {
    expect(parseComicPagesOwner('pipeline:iss:storyboards:scene1:shot2')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:comicPages:page3')).toBeNull();
  });
});
