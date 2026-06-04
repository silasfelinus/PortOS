import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  PIPELINE_STAGE_LABELS: { audio: 'Audio' },
  PIPELINE_STAGE_STATUS_LABEL: { empty: 'Empty', ready: 'Ready' },
  PIPELINE_STAGE_STATUS_COLOR: {},
  extractPipelineAudioLines: vi.fn(),
  renderPipelineAudioLine: vi.fn(),
  patchPipelineAudioLine: vi.fn(),
  listPipelineMusicLibrary: vi.fn(),
  uploadPipelineMusicTrack: vi.fn(),
  attachPipelineMusicTrack: vi.fn(),
  detachPipelineMusicTrack: vi.fn(),
  deletePipelineMusicTrack: vi.fn(),
  listPipelineMusicGenerators: vi.fn(),
  generatePipelineMusic: vi.fn(),
  generatePipelineAudioCues: vi.fn(),
  renderPipelineAudioCue: vi.fn(),
  updatePipelineIssue: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// VoicePicker fetches voices on mount — stub it out so the component renders
// without hitting the network.
vi.mock('../../voice/VoicePicker', () => ({ default: () => null }));

import AudioStage from './AudioStage';
import {
  updatePipelineIssue,
  generatePipelineAudioCues,
  renderPipelineAudioCue,
  listPipelineMusicGenerators,
} from '../../../services/api';

const READY_ENGINE = {
  engines: [{
    id: 'musicgen', name: 'MusicGen', models: [{ id: 'm', name: 'M' }],
    defaultModelId: 'm', defaultDurationSec: 12, minDurationSec: 1, maxDurationSec: 30,
    ready: true,
  }],
  defaultEngine: 'musicgen',
};
const NOT_READY_ENGINE = {
  engines: [{
    id: 'musicgen', name: 'MusicGen', models: [], defaultModelId: 'm',
    defaultDurationSec: 12, minDurationSec: 1, maxDurationSec: 30, ready: false,
  }],
  defaultEngine: 'musicgen',
};

const makeIssue = (audio = {}) => ({
  id: 'iss-1',
  seriesId: 'ser-1',
  stages: {
    storyboards: { scenes: [{ id: 's1' }] },
    audio: { status: 'ready', lines: [], music: null, audioMode: 'per-clip', cues: [], ...audio },
  },
});

describe('AudioStage — whole-episode audio (#863)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPipelineMusicGenerators.mockResolvedValue(READY_ENGINE);
  });

  it('renders the audio-mode selector with the persisted value', () => {
    render(<AudioStage issue={makeIssue({ audioMode: 'silent' })} onStageUpdate={() => {}} />);
    const select = screen.getByLabelText('Episode audio');
    expect(select).toHaveValue('silent');
  });

  it('persists a mode switch via updatePipelineIssue and lifts the new issue', async () => {
    const updated = makeIssue({ audioMode: 'silent' });
    updatePipelineIssue.mockResolvedValue(updated);
    const onStageUpdate = vi.fn();
    render(<AudioStage issue={makeIssue()} onStageUpdate={onStageUpdate} />);

    await userEvent.selectOptions(screen.getByLabelText('Episode audio'), 'silent');

    await waitFor(() => expect(updatePipelineIssue).toHaveBeenCalledWith(
      'iss-1',
      { stages: { audio: { audioMode: 'silent' } } },
      { silent: true },
    ));
    await waitFor(() => expect(onStageUpdate).toHaveBeenCalledWith('audio', updated.stages.audio, updated));
  });

  it('shows the cue panel only in generated mode', () => {
    const { rerender } = render(<AudioStage issue={makeIssue()} onStageUpdate={() => {}} />);
    expect(screen.queryByText('Music cues')).not.toBeInTheDocument();
    rerender(<AudioStage issue={makeIssue({ audioMode: 'generated' })} onStageUpdate={() => {}} />);
    expect(screen.getByText('Music cues')).toBeInTheDocument();
  });

  it('derives cues via the generate route', async () => {
    const issue = makeIssue({ audioMode: 'generated', cues: [] });
    const result = { issue: makeIssue({ audioMode: 'generated' }), stage: { cues: [] }, cueCount: 3 };
    generatePipelineAudioCues.mockResolvedValue(result);
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /Generate cues/i }));

    await waitFor(() => expect(generatePipelineAudioCues).toHaveBeenCalledWith(
      'iss-1',
      { engine: 'musicgen', force: false },
      { silent: true },
    ));
  });

  it('renders one cue, awaiting an in-flight prompt save first', async () => {
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads', startSec: 0, endSec: 10 }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    renderPipelineAudioCue.mockResolvedValue({ issue, stage: { cues }, cueIdx: 0, cue: cues[0] });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    // Let the lazily-fetched generators land so the engine reads as ready.
    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    await userEvent.click(within(cueItem).getByRole('button', { name: /Render/i }));

    await waitFor(() => expect(renderPipelineAudioCue).toHaveBeenCalledWith(
      'iss-1',
      0,
      { engine: 'musicgen' },
      { silent: true },
    ));
  });

  it('disables cue render when the engine is not installed', async () => {
    listPipelineMusicGenerators.mockResolvedValue(NOT_READY_ENGINE);
    const cues = [{ id: 'cue-1', label: 'Act I', prompt: 'warm pads', startSec: 0, endSec: 10 }];
    const issue = makeIssue({ audioMode: 'generated', cues });
    render(<AudioStage issue={issue} onStageUpdate={() => {}} />);

    await waitFor(() => expect(listPipelineMusicGenerators).toHaveBeenCalled());

    const cueItem = screen.getByText('Act I').closest('li');
    await waitFor(() => expect(within(cueItem).getByRole('button', { name: /Render/i })).toBeDisabled());
    expect(renderPipelineAudioCue).not.toHaveBeenCalled();
  });
});
