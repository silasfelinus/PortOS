import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useNavWorkingSet } from './useNavWorkingSet.js';
import { RECENT_KEY, PINNED_KEY } from '../utils/navWorkingSet.js';

// Minimal resolver: label is the last path segment, icon is a sentinel.
const ICON = () => null;
const resolveNavEntry = (path) => ({ path, label: path.replace('/', '') || 'home', icon: ICON });

function wrapper({ children }) {
  return <MemoryRouter initialEntries={['/start']}>{children}</MemoryRouter>;
}

describe('useNavWorkingSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records the initial route as a recent visit', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    expect(result.current.recent.map((r) => r.path)).toEqual(['/start']);
  });

  it('pin() persists to localStorage and exposes resolved rows', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.pin('/brain/inbox'));
    expect(result.current.isPinned('/brain/inbox')).toBe(true);
    expect(result.current.pinned).toEqual([
      { path: '/brain/inbox', label: 'brain/inbox', icon: ICON },
    ]);
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual(['/brain/inbox']);
  });

  it('unpin() removes a pin', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/a', '/b']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.unpin('/a'));
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/b']);
  });

  it('excludes pinned and the current path from recent', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['/start', '/x', '/y']));
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/x']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    // current path is /start (excluded), /x is pinned (excluded) -> only /y
    expect(result.current.recent.map((r) => r.path)).toEqual(['/y']);
  });

  it('drops paths the resolver cannot resolve', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/known']));
    const partialResolver = (path) => (path === '/known' ? { path, label: 'known', icon: ICON } : null);
    const { result } = renderHook(() => useNavWorkingSet(partialResolver), { wrapper });
    act(() => result.current.pin('/unknown'));
    // /unknown is stored but unresolvable -> not displayed
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/known']);
  });
});
