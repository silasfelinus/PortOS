/**
 * Pipeline comic-pages — filename hook.
 *
 * Stamps `filename` onto the matching cover/page record on media-job
 * completion so the UI keeps rendering after mediaJobQueue's 24h archive
 * TTL expires. Panel renders are intentionally NOT handled here —
 * enqueueVisualImage's owner string doesn't encode page/panel position,
 * so the hook can't locate the target. Encode position into that owner
 * before extending this hook to panels.
 */

import { parseComicPagesOwner } from './owners.js';
import { createFilenameHook } from './filenameHookFactory.js';

const hook = createFilenameHook({
  name: 'comicPages',
  stageId: 'comicPages',
  parseOwner: parseComicPagesOwner,
  applyFilename: (currentStage, parsed, job, filename) => {
    if (parsed.target === 'cover') {
      // Only stamp if THIS job is still the cover's active render — a
      // re-render that landed between enqueue and this event would
      // otherwise be overwritten with the older filename.
      const cover = currentStage?.cover;
      if (!cover || cover.imageJobId !== job.id) return null;
      return { patch: { cover: { ...cover, filename } }, label: 'cover' };
    }
    const pages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
    const page = pages[parsed.pageIndex];
    if (!page || page.imageJobId !== job.id) return null;
    const nextPages = [...pages];
    nextPages[parsed.pageIndex] = { ...page, filename };
    return { patch: { pages: nextPages }, label: `page${parsed.pageIndex}` };
  },
});

export const initComicPagesFilenameHook = hook.init;
export const __testing = hook.__testing;
