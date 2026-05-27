import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const STEPS = [
  { id: 'idea', label: 'Idea', description: 'Capture a starter idea.' },
  { id: 'universeAesthetic', label: 'Universe Aesthetic', description: 'Lock the look.' },
  { id: 'plotArc', label: 'Plot Arc', description: 'Expand the arc.' },
  { id: 'readerMap', label: 'Reader Map', description: 'Plan the reader experience.' },
  { id: 'characters', label: 'Characters', description: 'Lock the cast.' },
  { id: 'issues', label: 'Issues', description: 'Complete issues.' },
  { id: 'production', label: 'Production', description: 'Render.' },
];

const mkSteps = (overrides = {}) => Object.fromEntries(STEPS.map((s) => [
  s.id, overrides[s.id] || { status: 'pending', locked: false, lockedAt: null, upstreamHash: null },
]));

const api = vi.hoisted(() => ({
  getStoryBuilderSteps: vi.fn(),
  listStorySessions: vi.fn(),
  getStorySession: vi.fn(),
  createStorySession: vi.fn(),
  updateStorySession: vi.fn(),
  setStoryCurrentStep: vi.fn(),
  lockStoryStep: vi.fn(),
  unlockStoryStep: vi.fn(),
  generateStoryStep: vi.fn(),
  refineStoryStep: vi.fn(),
  setStoryIssueLock: vi.fn(),
  getUniverse: vi.fn(),
  getPipelineSeries: vi.fn(),
  listPipelineIssues: vi.fn(),
}));
vi.mock('../services/api', () => api);

import StoryBuilder from './StoryBuilder';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/story-builder" element={<StoryBuilder />} />
      <Route path="/story-builder/:storyId/:step" element={<StoryBuilder />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getStoryBuilderSteps.mockResolvedValue({ steps: STEPS });
  api.listStorySessions.mockResolvedValue([]);
  api.setStoryCurrentStep.mockResolvedValue({});
  api.lockStoryStep.mockResolvedValue({});
  api.unlockStoryStep.mockResolvedValue({});
  api.generateStoryStep.mockResolvedValue({ result: {} });
  api.refineStoryStep.mockResolvedValue({ result: {}, changes: [] });
  api.setStoryIssueLock.mockResolvedValue({});
  api.getUniverse.mockResolvedValue({ id: 'u1', logline: 'L', premise: 'P', styleNotes: 'S', influences: { embrace: [], avoid: [] }, characters: [] });
  api.getPipelineSeries.mockResolvedValue({ id: 's1', arc: { logline: 'AL', summary: 'AS', readerMap: { hooks: [{ id: 'rm-1', label: 'Why?' }] } } });
  api.listPipelineIssues.mockResolvedValue([]);
});

describe('StoryBuilder — index', () => {
  it('renders the create form', async () => {
    renderAt('/story-builder');
    expect(await screen.findByText('Start a new story')).toBeTruthy();
    expect(screen.getByLabelText('Universe / story name')).toBeTruthy();
  });
});

describe('StoryBuilder — detail stepper', () => {
  it('gates the Next button until the active step is locked', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'idea', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1', steps: mkSteps(), staleSteps: [],
    });
    renderAt('/story-builder/stb-1/idea');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Idea' })).toBeTruthy());
    // Idea not locked → primary action is "Lock & continue" and Next is disabled.
    expect(screen.getByText('Lock & continue')).toBeTruthy();
    const next = screen.getByRole('button', { name: /Next/i });
    expect(next.disabled).toBe(true);
  });

  it('shows the stale warning + "Unlock to revise" when an upstream step changed', async () => {
    api.getStorySession.mockResolvedValue({
      id: 'stb-1', title: 'Salt Run', currentStep: 'readerMap', seedIdea: 'seed',
      universeId: 'u1', seriesId: 's1',
      steps: mkSteps({
        idea: { status: 'locked', locked: true },
        universeAesthetic: { status: 'locked', locked: true },
        plotArc: { status: 'locked', locked: true },
        readerMap: { status: 'locked', locked: true, upstreamHash: 'old' },
      }),
      staleSteps: ['readerMap'],
    });
    renderAt('/story-builder/stb-1/readerMap');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reader Map' })).toBeTruthy());
    expect(screen.getByText(/re-review and re-lock/i)).toBeTruthy();
    // Locked step → the action flips to "Unlock to revise".
    expect(screen.getByText('Unlock to revise')).toBeTruthy();
  });
});
