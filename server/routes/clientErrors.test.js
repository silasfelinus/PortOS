import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/clientErrors.js', () => ({
  recordClientError: vi.fn(),
}));

const svc = await import('../services/clientErrors.js');
const { default: routes } = await import('./clientErrors.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/client-errors', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/client-errors', () => {
  it('accepts a well-formed error payload and forwards it to the service', async () => {
    svc.recordClientError.mockResolvedValue({ accepted: true, itemId: 'r1' });
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({
        type: 'error',
        message: 'boom',
        stack: 'Error: boom\n    at foo (foo.js:1:1)',
        url: 'https://portos/dash',
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true, itemId: 'r1' });
    expect(svc.recordClientError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'boom' }),
    );
  });

  it('accepts an unhandledrejection payload', async () => {
    svc.recordClientError.mockResolvedValue({ accepted: true, itemId: 'r2' });
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({ type: 'unhandledrejection', message: 'rejected' });
    expect(res.status).toBe(202);
    expect(svc.recordClientError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'unhandledrejection' }),
    );
  });

  it('echoes back the dedup / rate-limit reasons from the service', async () => {
    svc.recordClientError.mockResolvedValue({ accepted: false, reason: 'duplicate' });
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({ type: 'error', message: 'boom' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('rejects an unknown type with 400', async () => {
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({ type: 'panic', message: 'boom' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(svc.recordClientError).not.toHaveBeenCalled();
  });

  it('rejects a payload with a message that exceeds the cap', async () => {
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({ type: 'error', message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(svc.recordClientError).not.toHaveBeenCalled();
  });

  it('rejects a payload missing the message field', async () => {
    const res = await request(makeApp())
      .post('/api/client-errors')
      .send({ type: 'error' });
    expect(res.status).toBe(400);
    expect(svc.recordClientError).not.toHaveBeenCalled();
  });
});
