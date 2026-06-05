import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PINNED_KEY } from '../utils/navWorkingSet.js';

// This suite locks the *integration* path that SingleNavRow.test.jsx can't reach:
// pinning a top-level `single: true` row (Dashboard `/`, Review Hub `/review`,
// City `/city`, Goals `/goals/list`) must make it render in the sidebar Pinned
// section. That resolution lives in Layout itself — `navEntryByPath` indexes
// `item.single` leaves, `resolveNavEntry` maps a stored path to a row, and
// `useNavWorkingSet` feeds the Pinned-section render. We exercise the real
// nav-working-set path (seeded via localStorage) and mock everything else Layout
// pulls in (notification hooks, sockets, api fetches, theme, heavy child widgets)
// so the render is deterministic and side-effect free.

// --- Notification / status hooks: no-op, except useNotifications which feeds the
//     dropdown + the single-row badge count. ---
vi.mock('../hooks/useErrorNotifications', () => ({ useErrorNotifications: () => {} }));
vi.mock('../hooks/useSharingNotifications', () => ({ useSharingNotifications: () => {} }));
vi.mock('../hooks/useAgentFeedbackToast', () => ({ useAgentFeedbackToast: () => {} }));
vi.mock('../hooks/useAIStatusNotifications', () => ({ useAIStatusNotifications: () => {} }));
vi.mock('../hooks/useUpdateChecker', () => ({ useUpdateChecker: () => {} }));
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

// --- Theme context: Layout reads `theme.mode` for the day/night toggle. ---
vi.mock('./ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: 'night', label: 'Test', pair: null }, toggleMode: vi.fn() }),
}));

// --- Heavy child widgets: render nothing so they don't open sockets / fetch. ---
vi.mock('./Logo', () => ({ default: () => null }));
vi.mock('./NotificationDropdown', () => ({ default: () => null }));
vi.mock('./voice/VoiceToggleButton', () => ({ default: () => null }));
vi.mock('./voice/VoiceWidget', () => ({ default: () => null }));
vi.mock('./CmdKSearch', () => ({ default: () => null }));
vi.mock('./KeyboardHelp', () => ({ default: () => null }));

// --- Socket: record handlers, never connect. ---
vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

// --- API: every sidebar fetch resolves empty so the dynamic sections stay bare
//     and the single rows are the only top-level leaves under test. ---
vi.mock('../services/api', () => ({
  getApps: vi.fn(() => Promise.resolve([])),
  listPipelineSeries: vi.fn(() => Promise.resolve([])),
  listUniverses: vi.fn(() => Promise.resolve([])),
  getPaletteManifest: vi.fn(() => Promise.resolve({ nav: [] })),
}));

import Layout from './Layout';

const renderLayout = (initialPath = '/brain/inbox') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Layout />
    </MemoryRouter>,
  );

// Find the "Pinned" section heading and return its container so assertions are
// scoped to the Pinned region (the same label also exists in the main nav tree).
const pinnedSection = () => {
  const heading = screen.getByText('Pinned');
  return heading.parentElement;
};

beforeEach(() => {
  localStorage.clear();
  // __APP_VERSION__ is a Vite build-time define; undefined under vitest.
  vi.stubGlobal('__APP_VERSION__', 'test');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Layout — pinned single nav rows', () => {
  it('renders a pinned top-level single row (Dashboard) in the Pinned section', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/']));
    renderLayout();

    const pinned = pinnedSection();
    expect(pinned).toBeTruthy();
    // The Dashboard row resolved through navEntryByPath → its label links to '/'.
    const link = within(pinned).getByRole('link', { name: /Dashboard/i });
    expect(link).toHaveAttribute('href', '/');
    // And it carries the Unpin affordance (it's pinned).
    expect(within(pinned).getByRole('button', { name: /^Unpin Dashboard$/i })).toBeTruthy();
  });

  it('resolves every top-level single row by path into the Pinned section', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/', '/review', '/city', '/goals/list']));
    renderLayout();

    const pinned = pinnedSection();
    expect(within(pinned).getByRole('link', { name: /Dashboard/i })).toHaveAttribute('href', '/');
    expect(within(pinned).getByRole('link', { name: /Review Hub/i })).toHaveAttribute('href', '/review');
    expect(within(pinned).getByRole('link', { name: /City/i })).toHaveAttribute('href', '/city');
    expect(within(pinned).getByRole('link', { name: /Goals/i })).toHaveAttribute('href', '/goals/list');
  });

  it('omits the Pinned section entirely when nothing is pinned', () => {
    renderLayout();
    expect(screen.queryByText('Pinned')).toBeNull();
  });

  it('does not surface an unknown pinned path (filtered by resolveNavEntry)', () => {
    // A stored path that maps to no nav leaf and no manifest entry resolves to
    // null and is dropped — so the Pinned section never renders for it alone.
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/this/path/does/not/exist']));
    renderLayout();
    expect(screen.queryByText('Pinned')).toBeNull();
  });
});
