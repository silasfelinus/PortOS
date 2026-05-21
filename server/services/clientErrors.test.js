import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./review.js', () => ({
  createItem: vi.fn(),
}));

const review = await import('./review.js');
const { recordClientError, _resetForTests } = await import('./clientErrors.js');

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  review.createItem.mockImplementation(async ({ title, metadata }) => ({
    id: `item-${metadata?.referenceId ?? title}`,
    title,
    metadata,
  }));
});

describe('recordClientError', () => {
  it('forwards the first report to Review Hub as an alert with a referenceId', async () => {
    const result = await recordClientError({
      type: 'error',
      message: 'Cannot read properties of undefined',
      stack: 'TypeError: x\n    at Foo (foo.js:1:1)',
      url: 'https://portos/dashboard',
      source: '/assets/index.js',
      line: 42,
      column: 7,
    });

    expect(result.accepted).toBe(true);
    expect(review.createItem).toHaveBeenCalledTimes(1);
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.type).toBe('alert');
    expect(arg.title).toMatch(/^Client error: /);
    expect(arg.metadata.category).toBe('client-error');
    expect(arg.metadata.referenceId).toMatch(/^client-error:[0-9a-f]{16}$/);
  });

  it('redacts api-key-shaped secrets in the message and stack', async () => {
    await recordClientError({
      type: 'error',
      message: 'fetch failed with apiKey="sk-abcdef0123456789abcdef0123" and details',
      stack: 'Error\n    at AuthorizedRequest (api.js:5:9) bearer abcdef0123456789abcdef',
    });

    const arg = review.createItem.mock.calls[0][0];
    expect(arg.title).toContain('[REDACTED]');
    expect(arg.description).toContain('[REDACTED]');
    expect(arg.description).not.toContain('sk-abcdef0123456789abcdef0123');
  });

  it('strips the query string from the captured page URL', async () => {
    await recordClientError({
      type: 'error',
      message: 'boom',
      url: 'https://portos/secret?token=keepout',
    });

    const arg = review.createItem.mock.calls[0][0];
    expect(arg.description).toContain('URL: https://portos/secret');
    expect(arg.description).not.toContain('token=keepout');
  });

  it('drops duplicate reports within the dedup window', async () => {
    const payload = {
      type: 'error',
      message: 'same error',
      stack: 'Error: same error\n    at foo (foo.js:1:1)\n    at bar (bar.js:2:2)',
    };
    const first = await recordClientError(payload);
    expect(first.accepted).toBe(true);

    // Wait past the 1s rate-limit so the dedup branch (not rate-limit) is exercised.
    const realDateNow = Date.now;
    const fakeNow = realDateNow() + 2000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);

    const second = await recordClientError(payload);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(review.createItem).toHaveBeenCalledTimes(1);

    Date.now = realDateNow;
  });

  it('drops reports that arrive faster than the 1/sec throttle', async () => {
    const first = await recordClientError({
      type: 'error',
      message: 'err A',
      stack: 'Error: A\n    at a (a.js:1:1)',
    });
    expect(first.accepted).toBe(true);

    const second = await recordClientError({
      type: 'error',
      message: 'err B',
      stack: 'Error: B\n    at b (b.js:1:1)',
    });
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(review.createItem).toHaveBeenCalledTimes(1);
  });

  it('truncates oversize messages and stacks rather than passing them through', async () => {
    await recordClientError({
      type: 'error',
      message: 'm'.repeat(2000),
      stack: 's'.repeat(20000),
    });
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.title.length).toBeLessThan(200);
    expect(arg.description.length).toBeLessThan(5000);
  });

  it('returns a failure marker when the Review Hub write fails', async () => {
    review.createItem.mockRejectedValueOnce(new Error('disk full'));
    const result = await recordClientError({ type: 'error', message: 'boom' });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('review-hub-write-failed');
  });

  it('throttles subsequent calls even when the previous Review Hub write failed', async () => {
    review.createItem.mockRejectedValueOnce(new Error('disk full'));
    const first = await recordClientError({
      type: 'error',
      message: 'first failing error',
      stack: 'Error: first\n    at foo (a.js:1:1)',
    });
    expect(first.reason).toBe('review-hub-write-failed');

    const second = await recordClientError({
      type: 'error',
      message: 'second distinct error',
      stack: 'Error: second\n    at bar (b.js:1:1)',
    });
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(review.createItem).toHaveBeenCalledTimes(1);
  });

  it('strips the query string from the source script URL', async () => {
    await recordClientError({
      type: 'error',
      message: 'boom',
      source: '/assets/index-abc.js?token=keepout',
    });
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.description).toContain('Source: /assets/index-abc.js');
    expect(arg.description).not.toContain('token=keepout');
    expect(arg.metadata.source).toBe('/assets/index-abc.js');
  });
});
