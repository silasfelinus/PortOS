import { describe, it, expect } from 'vitest';

// Faithful inline model of Dashboard.jsx's active-layout switch+revert state
// machine (selectLayout + the serverConfirmedLayoutIdRef). The real Dashboard
// page renders lazy Suspense widgets and a live socket, which makes the
// optimistic-set / async-revert timing hard to assert deterministically — so
// this models just the revert logic. Keep it in sync with Dashboard.jsx:
//   - optimistic setActiveLayoutId(id) up front
//   - on PUT success: serverConfirmedLayoutIdRef.current = id
//   - on PUT failure: revert via functional setState, current === id ? confirmed : current
function createLayoutSwitcher(serverActiveId) {
  let displayed = serverActiveId;                       // activeLayoutId
  const serverConfirmed = { current: serverActiveId };  // serverConfirmedLayoutIdRef

  // Mirrors: await api.setActiveDashboardLayout(id).then(...).catch(...)
  // `put` is a promise the caller resolves/rejects to stand in for the PUT.
  const selectLayout = (id, put) => {
    displayed = id; // optimistic
    return put
      .then(() => { serverConfirmed.current = id; })
      .catch(() => {
        // functional setState — only revert if still showing the failed id
        displayed = displayed === id ? serverConfirmed.current : displayed;
      });
  };

  return {
    selectLayout,
    get displayed() { return displayed; },
    get confirmed() { return serverConfirmed.current; },
  };
}

describe('Dashboard active-layout revert', () => {
  it('reverts to the server-confirmed id on a single failed switch', async () => {
    const sw = createLayoutSwitcher('A');
    await sw.selectLayout('B', Promise.reject(new Error('boom')));
    expect(sw.displayed).toBe('A');
    expect(sw.confirmed).toBe('A');
  });

  it('reverts to the server-confirmed id (A) after TWO consecutive failed switches — not the never-committed intermediate id (B)', async () => {
    // The bug: selectLayout used a per-call `previousId` snapshot. The 2nd
    // switch's previousId was 'B' (the 1st switch's optimistic-but-uncommitted
    // value), so a double failure snapped the UI to 'B' — a layout the server
    // never accepted. Tracking the last *server-confirmed* id fixes it.
    const sw = createLayoutSwitcher('A');
    const pB = sw.selectLayout('B', Promise.reject(new Error('boom'))); // displayed -> B
    const pC = sw.selectLayout('C', Promise.reject(new Error('boom'))); // displayed -> C
    await Promise.allSettled([pB, pC]);
    expect(sw.displayed).toBe('A'); // server truth, not the orphaned 'B'
    expect(sw.confirmed).toBe('A');
  });

  it('advances the confirmed baseline on a successful switch, then reverts to it on a later failure', async () => {
    const sw = createLayoutSwitcher('A');
    await sw.selectLayout('B', Promise.resolve());            // server now active = B
    expect(sw.confirmed).toBe('B');
    await sw.selectLayout('C', Promise.reject(new Error('boom')));
    expect(sw.displayed).toBe('B'); // reverts to the now-confirmed B, not A
    expect(sw.confirmed).toBe('B');
  });

  it('a stale failure does not clobber a later in-flight selection', async () => {
    const sw = createLayoutSwitcher('A');
    let failB;
    const pB = sw.selectLayout('B', new Promise((_, reject) => { failB = reject; }));
    const pC = sw.selectLayout('C', Promise.resolve()); // C selected + confirmed first
    await pC;
    failB(new Error('boom')); // B's PUT now fails, but user is on C
    await pB;
    expect(sw.displayed).toBe('C'); // functional-setState guard preserves C
    expect(sw.confirmed).toBe('C');
  });
});
