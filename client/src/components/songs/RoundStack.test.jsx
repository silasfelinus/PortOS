import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the audio mixer — jsdom has no Web Audio. Capture the takes it receives
// so we can assert RoundStack flattens recordings across ALL stacked songs.
const playerCalls = vi.hoisted(() => ({ takes: null, play: null, stop: null }));
vi.mock('../../lib/songPlayback', () => ({
  createLayeredPlayer: (takes) => {
    playerCalls.takes = takes;
    playerCalls.play = vi.fn().mockResolvedValue(undefined);
    playerCalls.stop = vi.fn();
    return { play: playerCalls.play, stop: playerCalls.stop, onEnded: vi.fn() };
  },
}));
// getUploadUrl is the only thing RoundStack needs from the api barrel.
vi.mock('../../services/api', () => ({ getUploadUrl: (f) => `/api/uploads/${f}` }));

import RoundStack from './RoundStack.jsx';

const SCORE_A = ['clef: treble', 'key: C', 'time: 4/4', '', '| D4q(Hey) D4q(ho) D4h(home) |'].join('\n');
const SCORE_B = ['clef: treble', 'key: C', 'time: 4/4', '', '| F4q(Ah) F4q(poor) F4h(bird) |'].join('\n');

const SONGS = [
  {
    id: 'seed-hey-ho-nobody-home', title: 'Hey Ho Nobody Home', key: 'D minor', score: SCORE_A,
    sections: [{ id: 's1', label: 'Round', lyrics: 'Hey ho nobody home' }],
    recordings: [{ id: 'rec-1', filename: 'a.wav', muted: false }],
  },
  {
    id: 'seed-ah-poor-bird', title: 'Ah Poor Bird', key: 'D minor', score: SCORE_B,
    sections: [{ id: 's2', label: 'Verse', lyrics: 'Ah poor bird' }],
    recordings: [{ id: 'rec-2', filename: 'b.wav', muted: false }],
  },
];

const renderStack = (songs) => render(
  <MemoryRouter><RoundStack songs={songs} /></MemoryRouter>,
);

describe('RoundStack', () => {
  beforeEach(() => { playerCalls.takes = null; });

  it('renders nothing for an empty list', () => {
    const { container } = renderStack([]);
    expect(container.firstChild).toBeNull();
  });

  it('renders a score and lyrics for each stacked song', () => {
    renderStack(SONGS);
    expect(screen.getByText('Hey Ho Nobody Home')).toBeTruthy();
    expect(screen.getByText('Ah Poor Bird')).toBeTruthy();
    expect(screen.getByText('Hey ho nobody home')).toBeTruthy();
    expect(screen.getByText('Ah poor bird')).toBeTruthy();
    // One rendered staff per song.
    expect(screen.getAllByLabelText('Sheet music notation')).toHaveLength(2);
  });

  it('plays the recorded takes from every song together', () => {
    renderStack(SONGS);
    fireEvent.click(screen.getByRole('button', { name: /Play all parts/i }));
    expect(playerCalls.takes).toHaveLength(2);
    // Ids are namespaced by song so two songs' takes can't collide in the mixer.
    expect(playerCalls.takes.map((t) => t.id)).toEqual([
      'seed-hey-ho-nobody-home:rec-1',
      'seed-ah-poor-bird:rec-2',
    ]);
    expect(playerCalls.play).toHaveBeenCalled();
  });

  it('hides the play button when no song has an audible take', () => {
    const muted = SONGS.map((s) => ({ ...s, recordings: [] }));
    renderStack(muted);
    expect(screen.queryByRole('button', { name: /Play all parts/i })).toBeNull();
  });
});
