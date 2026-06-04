import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// All five flows reuse the shared API barrel. Stub the functions each flow
// touches so the hub + flow dispatch can be exercised without a server.
vi.mock('../services/api', () => ({
  getSystemHealth: vi.fn().mockResolvedValue({
    overallHealth: 'healthy',
    hostname: 'void',
    system: {
      uptimeFormatted: '2h 3m',
      memory: { used: 8e9, total: 16e9, usagePercent: 50 },
      cpu: { cores: 8, usagePercent: 20 },
      disk: { free: 5e11, usagePercent: 40 },
    },
    thresholds: {},
    warnings: [],
  }),
  getApps: vi.fn().mockResolvedValue([
    { id: 'app1', name: 'BookLoom', overallStatus: 'online' },
    { id: 'native', name: 'iOSApp', overallStatus: 'n/a' },
    { id: 'old', name: 'OldApp', overallStatus: 'stopped', archived: true },
  ]),
  restartApp: vi.fn().mockResolvedValue({ ok: true }),
  handleSelfRestart: vi.fn(),
  captureBrainThought: vi.fn().mockResolvedValue({ id: 'log1' }),
  streamAskTurn: vi.fn().mockResolvedValue(undefined),
  getCosTasks: vi.fn().mockResolvedValue({ cos: { awaitingApproval: [] } }),
  approveCosTask: vi.fn().mockResolvedValue({ id: 't1' }),
  deleteCosTask: vi.fn().mockResolvedValue({ ok: true }),
  logAlcoholDrink: vi.fn().mockResolvedValue({ ok: true }),
  logNicotine: vi.fn().mockResolvedValue({ ok: true }),
  getCustomDrinks: vi.fn().mockResolvedValue([]),
  getCustomNicotineProducts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

// VoiceCapture uses Web Speech; stub to a no-op button.
vi.mock('../components/brain/VoiceCapture', () => ({
  default: () => <button type="button">mic</button>,
}));

import Mobile from './Mobile';
import * as api from '../services/api';
import { MOBILE_FLOWS } from '../components/mobile/flows';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/mobile" element={<Mobile />} />
        <Route path="/mobile/:flow" element={<Mobile />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Mobile hub', () => {
  it('renders a tile for every flow', () => {
    renderAt('/mobile');
    expect(screen.getByText('Quick Actions')).toBeTruthy();
    for (const f of MOBILE_FLOWS) {
      expect(screen.getByText(f.label)).toBeTruthy();
    }
  });

  it('links each tile to its deep-linkable flow route', () => {
    renderAt('/mobile');
    const link = screen.getByText('Capture').closest('a');
    expect(link.getAttribute('href')).toBe('/mobile/capture');
  });
});

describe('Mobile flow dispatch', () => {
  it('renders the log flow with one-tap presets and posts silently on tap', async () => {
    renderAt('/mobile/log');
    const beerBtn = await screen.findByText('Beer');
    fireEvent.click(beerBtn.closest('button'));
    await waitFor(() => {
      // Flow owns its own error toast, so the API call must be silent.
      expect(api.logAlcoholDrink).toHaveBeenCalledWith({ name: 'Beer', oz: 12, abv: 5 }, { silent: true });
    });
  });

  it('renders the approve flow empty state when nothing awaits approval', async () => {
    renderAt('/mobile/approve');
    expect(await screen.findByText(/Nothing awaiting approval/i)).toBeTruthy();
  });

  it('renders the health flow with a restart button for managed, non-archived apps only', async () => {
    renderAt('/mobile/health');
    expect(await screen.findByText('BookLoom')).toBeTruthy();
    // n/a (native) and archived apps are filtered out of the restartable list.
    expect(screen.queryByText('iOSApp')).toBeNull();
    expect(screen.queryByText('OldApp')).toBeNull();
    fireEvent.click(screen.getByLabelText('Restart BookLoom'));
    await waitFor(() => expect(api.restartApp).toHaveBeenCalledWith('app1', { silent: true }));
  });

  it('redirects an unknown flow slug back to the hub', () => {
    renderAt('/mobile/bogus');
    expect(screen.getByText('Quick Actions')).toBeTruthy();
  });

  it('shows an explicit unavailable state when health never loads (not a false "Healthy")', async () => {
    // useAutoRefetch keeps data null when the fetch rejects.
    api.getSystemHealth.mockRejectedValueOnce(new Error('boom'));
    renderAt('/mobile/health');
    expect(await screen.findByText(/System health is unavailable/i)).toBeTruthy();
    expect(screen.queryByText('Healthy')).toBeNull();
  });

  it('shows an unavailable state for approvals when the queue fetch fails (not "Nothing awaiting")', async () => {
    api.getCosTasks.mockRejectedValueOnce(new Error('boom'));
    renderAt('/mobile/approve');
    expect(await screen.findByText(/Approvals are unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing awaiting approval/i)).toBeNull();
  });
});
