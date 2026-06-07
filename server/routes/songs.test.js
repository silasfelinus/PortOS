import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the service so the test isolates the ROUTE's validation/merge contract:
// we assert exactly what the route forwards to updateSong, independent of the
// JSON-file persistence (covered by services/songs.test.js).
const mocks = vi.hoisted(() => ({
  listSongs: vi.fn(),
  getSong: vi.fn(),
  createSong: vi.fn(),
  updateSong: vi.fn(),
  deleteSong: vi.fn(),
}));
vi.mock('../services/songs.js', async () => {
  const actual = await vi.importActual('../services/songs.js');
  return { ...actual, ...mocks };
});

import songsRoutes from './songs.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/songs', songsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('songs route', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it('GET / returns the song list', async () => {
    mocks.listSongs.mockResolvedValue([{ id: 'song-1', title: 'A' }]);
    const res = await request(makeApp()).get('/api/songs');
    expect(res.status).toBe(200);
    expect(res.body.songs).toEqual([{ id: 'song-1', title: 'A' }]);
  });

  it('GET /:id 404s with a NOT_FOUND code when the song is missing', async () => {
    mocks.getSong.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/songs/song-nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('PUT /:id forwards ONLY the keys the client sent — omitted fields are not clobbered', async () => {
    // Regression guard: a `.default('')` on the schema fields would make
    // .partial() materialize defaults for omitted keys, so a title-only PUT
    // would wipe artist/key/notation/notes via updateSong's `key in patch`
    // merge. The route must forward a patch containing ONLY `title`.
    mocks.updateSong.mockResolvedValue({ id: 'song-1', title: 'Renamed' });
    const res = await request(makeApp())
      .put('/api/songs/song-1')
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mocks.updateSong).toHaveBeenCalledTimes(1);
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect(patch).toEqual({ title: 'Renamed' });
    expect('artist' in patch).toBe(false);
    expect('key' in patch).toBe(false);
    expect('notation' in patch).toBe(false);
  });

  it('PUT /:id preserves an explicit empty-string clear (present, not absent)', async () => {
    mocks.updateSong.mockResolvedValue({ id: 'song-1', key: '' });
    await request(makeApp()).put('/api/songs/song-1').send({ key: '' });
    const [, patch] = mocks.updateSong.mock.calls[0];
    expect('key' in patch).toBe(true);
    expect(patch.key).toBe('');
  });

  it('PUT /:id maps a service NOT_FOUND to a 404', async () => {
    mocks.updateSong.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
    const res = await request(makeApp()).put('/api/songs/song-x').send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('POST / rejects an over-long title with a 400', async () => {
    const res = await request(makeApp())
      .post('/api/songs')
      .send({ title: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(mocks.createSong).not.toHaveBeenCalled();
  });

  it('POST / rejects a tempo outside the supported band', async () => {
    const res = await request(makeApp()).post('/api/songs').send({ title: 'A', tempo: 9000 });
    expect(res.status).toBe(400);
  });

  it('DELETE /:id returns the deleted id', async () => {
    mocks.deleteSong.mockResolvedValue({ id: 'song-1' });
    const res = await request(makeApp()).delete('/api/songs/song-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('song-1');
  });
});
