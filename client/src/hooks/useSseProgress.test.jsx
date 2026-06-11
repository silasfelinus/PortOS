import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSseProgress } from './useSseProgress';

// jsdom has no EventSource — minimal mock that records instances and lets a
// test drive onmessage / onerror by hand (same shape as useInstallStream's).
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this.closed = false;
    this.readyState = MockEventSource.OPEN;
    MockEventSource.instances.push(this);
  }

  close() { this.closed = true; this.readyState = MockEventSource.CLOSED; }

  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }

  fail() { this.readyState = MockEventSource.CLOSED; this.onerror?.(); }
}
MockEventSource.CONNECTING = 0;
MockEventSource.OPEN = 1;
MockEventSource.CLOSED = 2;

const last = () => MockEventSource.instances[MockEventSource.instances.length - 1];

beforeEach(() => {
  MockEventSource.instances = [];
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

describe('useSseProgress', () => {
  it('does not open a stream when url is null or enabled is false', () => {
    renderHook(() => useSseProgress(null));
    renderHook(() => useSseProgress('/x', { enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('accumulates frames and tracks the latest', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => {
      last().emit({ type: 'progress', progress: 0.25 });
      last().emit({ type: 'progress', progress: 0.5 });
    });
    expect(result.current.frames).toHaveLength(2);
    expect(result.current.latest).toEqual({ type: 'progress', progress: 0.5 });
    expect(result.current.closed).toBe(false);
  });

  it.each(['complete', 'canceled', 'cancelled', 'error'])(
    'closes the stream on a terminal %s frame',
    (type) => {
      const { result } = renderHook(() => useSseProgress('/x'));
      act(() => { last().emit({ type }); });
      expect(result.current.closed).toBe(true);
      expect(result.current.isOpen).toBe(false);
      expect(last().closed).toBe(true);
    },
  );

  it('marks the stream closed on a terminal connection failure', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => { last().fail(); });
    expect(result.current.closed).toBe(true);
    expect(result.current.latest).toBeNull();
  });

  it('resets state when the url changes', () => {
    const { result, rerender } = renderHook(({ url }) => useSseProgress(url), {
      initialProps: { url: '/a' },
    });
    act(() => { last().emit({ type: 'complete' }); });
    expect(result.current.closed).toBe(true);
    rerender({ url: '/b' });
    expect(result.current.closed).toBe(false);
    expect(result.current.frames).toHaveLength(0);
    expect(last().url).toBe('/b');
  });
});
