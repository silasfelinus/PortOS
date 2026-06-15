/**
 * ChatGPT ZIP Import Service
 *
 * Ingests the modern multi-file ChatGPT data export (a `.zip`, streamed up
 * whole — no in-memory cap) end to end:
 *
 *   1. Stream-extract the ZIP (`parseZip`) — never buffer the whole archive.
 *      - `conversations*.json` + `conversation_asset_file_names.json` are small
 *        relative to the assets and are buffered in memory.
 *      - `*.dat` asset files (images / voice audio / PDFs) are written to the
 *        served assets dir (`PATHS.brainImportAssets`) keyed by their global
 *        asset id, with a real extension sniffed from magic bytes (falling back
 *        to the friendly name in the asset-name map). `chat.html` and other
 *        bulky members are drained without buffering.
 *   2. Build a `pointer -> { url, name, mime }` resolver so transcript rendering
 *      can inline `![](url)` images and `[🔊 audio](url)` / `[📎 file](url)`
 *      links pointing at the extracted assets.
 *   3. Parse + import via the shared `chatgptImport` service, passing the
 *      resolver so every conversation's transcript embeds its assets.
 *
 * Both the legacy single-`conversations.json` JSON path (browser-parsed) and
 * this ZIP path converge on the same `parseExport`/`importConversations` — the
 * only difference is the `assetResolver`.
 */

import { createReadStream } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { Writable } from 'stream';
import { PATHS, getMimeType } from '../lib/fileUtils.js';
import { parseZip } from '../lib/zipStream.js';
import { parseExport, importConversations, assetPointerId } from './chatgptImport.js';

// Cap an individual buffered JSON member. The largest conversation shard in a
// real export is ~6 MB; 100 MB is a generous backstop against a malicious zip
// claiming a JSON member is enormous. Asset `.dat` files are streamed to disk,
// not buffered, so they aren't bound by this.
const MAX_JSON_MEMBER_BYTES = 100 * 1024 * 1024;

// Magic-byte sniffers — `.dat` files carry no extension, so we detect the real
// type from the leading bytes and give the served file a correct extension.
// Order matters (WebP's RIFF prefix is also used by WAV, so check the form id).
const sniffExtension = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF') {
    const form = buf.slice(8, 12).toString('ascii');
    if (form === 'WEBP') return '.webp';
    if (form === 'WAVE') return '.wav';
    return null;
  }
  // ID3-tagged or raw MPEG audio.
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return '.mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  return null;
};

// Friendly-name → extension fallback when magic-byte sniffing comes up empty.
const extFromName = (name) => {
  const m = String(name || '').match(/\.([a-z0-9]{1,5})$/i);
  return m ? `.${m[1].toLowerCase()}` : null;
};

const IS_DAT = (path) => path.endsWith('.dat');
const IS_CONVO_JSON = (path) => /(?:^|\/)conversations(?:-\d+)?\.json$/i.test(path);
const IS_ASSET_NAME_MAP = (path) => /(?:^|\/)conversation_asset_file_names\.json$/i.test(path);

// A `.dat` member's asset id is its basename without extension. Conversations
// reference assets as `file-service://file-XXX` / `sediment://file_HASH`, both
// of which `assetPointerId()` reduces to that same bare id.
const datAssetId = (path) => path.replace(/^.*\//, '').replace(/\.dat$/i, '');

// `parseZip` entries aren't readable streams — they expose `.pipe(dest)` /
// `.autodrain()`. Pipe the entry into a size-capped collecting Writable and
// resolve with the concatenated buffer.
const collect = (entry, max) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      size += chunk.length;
      if (size > max) { cb(new Error(`ZIP member exceeds ${max} byte limit`)); return; }
      chunks.push(chunk);
      cb();
    }
  });
  sink.on('finish', () => resolve(Buffer.concat(chunks)));
  sink.on('error', reject);
  entry.pipe(sink);
});

/**
 * Stream-extract a ChatGPT export ZIP at `zipPath`.
 *
 * Returns:
 *   {
 *     conversationFiles: Array<parsed JSON>,   // each conversations*.json
 *     assets: Map<assetId, { url, name, mime, file }>,
 *     assetNameMap: Record<datFilename, friendlyName>,
 *     stats: { assetCount, conversationFileCount, skippedAssets }
 *   }
 *
 * Assets are written to `data/brain/imports/assets/<assetId><ext>` and surfaced
 * at `/data/brain-imports/<assetId><ext>`.
 */
export async function extractChatgptZip(zipPath, { assetDir = PATHS.brainImportAssets } = {}) {
  await mkdir(assetDir, { recursive: true });

  const convoBuffers = [];          // { path, buffer }
  let assetNameMap = {};
  // assetId -> { datPath, buffer } collected during the stream; we resolve
  // extensions + write files after, because the name map may arrive after the
  // .dat members (member order in the ZIP isn't guaranteed).
  const pendingAssets = new Map();

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => (arg) => { if (!settled) { settled = true; fn(arg); } };
    const onErr = settle(reject);
    const inFlight = [];

    createReadStream(zipPath)
      .on('error', onErr)
      .pipe(parseZip())
      .on('entry', (entry) => {
        const { path } = entry;
        if (IS_ASSET_NAME_MAP(path)) {
          inFlight.push(collect(entry, MAX_JSON_MEMBER_BYTES)
            .then((buf) => { assetNameMap = JSON.parse(buf.toString('utf8')); })
            .catch(onErr));
        } else if (IS_CONVO_JSON(path)) {
          inFlight.push(collect(entry, MAX_JSON_MEMBER_BYTES)
            .then((buf) => { convoBuffers.push({ path, buffer: buf }); })
            .catch(onErr));
        } else if (IS_DAT(path)) {
          // Buffer the asset bytes. Asset `.dat` files in real exports are
          // individual media files (KB–few MB); collecting one at a time is
          // fine and lets us sniff magic bytes for the extension.
          inFlight.push(collect(entry, MAX_JSON_MEMBER_BYTES)
            .then((buf) => { pendingAssets.set(datAssetId(path), { datPath: path, buffer: buf }); })
            .catch(onErr));
        } else {
          // chat.html, export_manifest.json, library_files.json, user.json, etc.
          // — not needed for the transcript+asset import. Drain without buffering.
          entry.autodrain();
        }
      })
      .on('close', () => { Promise.all(inFlight).then(settle(resolve), onErr); })
      .on('error', onErr);
  });

  // Resolve each buffered asset's extension + write it to the served dir.
  const assets = new Map();
  for (const [assetId, { datPath, buffer }] of pendingAssets) {
    const friendlyName = assetNameMap[`${assetId}.dat`] || assetNameMap[datPath] || null;
    const ext = sniffExtension(buffer) || extFromName(friendlyName) || '.bin';
    const fileName = `${assetId}${ext}`;
    const filePath = `${assetDir}/${fileName}`;
    // eslint-disable-next-line no-await-in-loop -- sequential write keeps peak
    // disk/IO bounded; an export has a few hundred assets, not millions.
    await writeFile(filePath, buffer);
    assets.set(assetId, {
      url: `/data/brain-imports/${fileName}`,
      name: friendlyName || fileName,
      mime: getMimeType(ext),
      file: fileName,
    });
  }

  const conversationFiles = [];
  for (const { buffer } of convoBuffers) {
    conversationFiles.push(JSON.parse(buffer.toString('utf8')));
  }

  return {
    conversationFiles,
    assets,
    assetNameMap,
    stats: {
      assetCount: assets.size,
      conversationFileCount: conversationFiles.length,
    },
  };
}

/**
 * Build an `assetResolver(pointer)` closure over an extracted-assets Map.
 * Resolves `file-service://`, `sediment://`, and bare-id pointers to the
 * served asset descriptor, or null when the pointer's asset wasn't in the
 * export (ChatGPT omits expired/server-side-only assets — normal, not an error).
 */
export function makeAssetResolver(assets) {
  return (pointer) => {
    if (!pointer) return null;
    const id = assetPointerId(pointer);
    return assets.get(id) || null;
  };
}

/**
 * Full ZIP-import pipeline: extract → resolve assets → parse → import.
 * `zipPath` is a temp file (the streamed multipart upload); the caller owns
 * unlinking it. Returns the `importConversations` result augmented with asset
 * stats, plus the parsed preview summary.
 */
export async function importChatgptZip(zipPath, { tags, skipEmpty } = {}) {
  const { conversationFiles, assets, stats } = await extractChatgptZip(zipPath);
  if (conversationFiles.length === 0) {
    return { ok: false, error: 'No conversations*.json files found in the ZIP. Is this a ChatGPT data export?' };
  }

  const assetResolver = makeAssetResolver(assets);
  const parsed = parseExport({ conversationFiles }, { assetResolver });
  if (!parsed.ok) return parsed;

  const result = await importConversations(parsed, { tags, skipEmpty });
  return {
    ...result,
    summary: parsed.summary,
    assetStats: stats,
  };
}

export const __test = { sniffExtension, extFromName, datAssetId, makeAssetResolver };
