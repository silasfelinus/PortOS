/**
 * Pipeline comic-pages — filename hook.
 *
 * The pipeline previously stored only `imageJobId` on each cover/page.
 * `mediaJobQueue` prunes completed jobs after 24h, so the UI can no longer
 * resolve a filename to render even though the PNG is still on disk.
 * This listener stamps `filename` onto the record at completion time so
 * the client has a fallback that survives the queue's TTL.
 *
 * Panel renders are intentionally NOT handled here — `enqueueVisualImage`'s
 * owner string doesn't encode page/panel position, so we can't locate the
 * target record from the event alone. Encode position into that owner
 * before extending this hook to panels.
 *
 * Failures are logged but never thrown — a bookkeeping miss must not
 * crash the server or fail the user's render.
 */

import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateStageWithLatest } from './issues.js';
import { parseComicPagesOwner } from './owners.js';

let registeredHandler = null;

export function initComicPagesFilenameHook() {
  if (registeredHandler) return;

  registeredHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const filename = job.result?.filename;
      if (typeof filename !== 'string' || !filename) return;
      const parsed = parseComicPagesOwner(job.owner);
      if (!parsed) return;

      const shortId = String(job.id || '').slice(0, 8);
      let stamped = false;
      await updateStageWithLatest(
        parsed.issueId,
        'comicPages',
        (currentStage) => {
          if (parsed.target === 'cover') {
            const cover = currentStage?.cover;
            // Only stamp if THIS job is still the cover's active render —
            // a re-render that landed between enqueue and this event would
            // otherwise be overwritten with the older filename. Empty patch
            // is a no-op (updateStageWithLatest short-circuits on `{}`).
            if (!cover || cover.imageJobId !== job.id) return {};
            stamped = true;
            return { cover: { ...cover, filename } };
          }
          const pages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
          const page = pages[parsed.pageIndex];
          if (!page || page.imageJobId !== job.id) return {};
          const nextPages = [...pages];
          nextPages[parsed.pageIndex] = { ...page, filename };
          stamped = true;
          return { pages: nextPages };
        },
      ).catch((err) => {
        console.error(`❌ comicPages filename hook failed for job ${shortId}: ${err?.message || err}`);
      });

      if (stamped) {
        const where = parsed.target === 'cover' ? 'cover' : `page${parsed.pageIndex}`;
        console.log(`📎 comicPages filename stamped — issue=${parsed.issueId.slice(0, 8)} ${where} ← ${filename}`);
      }
    })().catch((err) => {
      console.error(`❌ comicPages filename hook crashed: ${err?.message || err}`);
    });
  };
  mediaJobEvents.on('completed', registeredHandler);
  console.log('📎 comicPages filename hook initialized');
}

export const __testing = {
  reset: () => {
    if (registeredHandler) {
      mediaJobEvents.off('completed', registeredHandler);
      registeredHandler = null;
    }
  },
};
