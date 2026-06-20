import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Check } from 'lucide-react';
import toast from '../ui/Toast';
import CollectionPickerShell from './CollectionPickerShell';
import {
  listMoodBoards,
  createMoodBoard,
  addMoodBoardItem,
  removeMoodBoardItem,
} from '../../services/api';

// Self-contained "Pin to mood board" popover button, the mood-board sibling of
// AddToCollectionMenu (issue #1455, follow-up to #911). It reuses the shared
// CollectionPickerShell with the mood-board API injected as the data source, so
// the popover positioning / search / inline-create plumbing isn't duplicated.
//
// `item` is the normalized MediaCard shape: `item.key` is the `<kind>:<ref>`
// media-key (e.g. `image:foo.png`, `video:job-123`) and `item.previewUrl` is a
// renderable thumbnail URL (or null). We pin as an `image`-type board item
// carrying that mediaKey for source linkage PLUS the previewUrl as `imageUrl`
// so the board renders the thumbnail directly — this is how video pins show a
// frame without the detail-page resolver needing to map a `video:` key back to
// a thumbnail filename (which it can't derive from the id alone).
//
// Membership is keyed on `mediaKey === item.key`: a board "contains" this asset
// when any of its items pins the same media-key. Pinning again removes it
// (toggle), matching the collection menu's behavior.

const SIZES = {
  sm: { button: 'px-1.5 py-1 text-[10px]', icon: 'w-3 h-3' },
  md: { button: 'px-2 py-1.5 text-xs', icon: 'w-3.5 h-3.5' },
};

// Find the board item that pins this media-key (or undefined).
const findPinned = (board, mediaKey) =>
  (Array.isArray(board?.items) ? board.items : []).find((it) => it?.mediaKey === mediaKey);

export default function PinToMoodBoardMenu({ item, size = 'sm' }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const triggerRef = useRef(null);

  const mediaKey = item.key;
  // Only http(s) / absolute app paths are valid imageUrls (matches the board
  // item schema); a missing/blob preview is dropped so we pin mediaKey-only.
  const thumbUrl = typeof item.previewUrl === 'string' && /^(https?:\/\/|\/)/.test(item.previewUrl)
    ? item.previewUrl
    : null;
  // The board item payload: the media-key for source linkage, plus the
  // thumbnail as imageUrl so a video pin (no derivable thumbnail from its key)
  // still renders. Built once so the toggle + create-and-pin paths can't drift.
  const pinPayload = useMemo(() => (thumbUrl
    ? { type: 'image', mediaKey, imageUrl: thumbUrl }
    : { type: 'image', mediaKey }), [mediaKey, thumbUrl]);

  const handleToggleOpen = (e) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  const handleTogglePin = useCallback(async (board, updateBoards) => {
    const pinned = findPinned(board, mediaKey);
    setBusyId(board.id);
    if (pinned) {
      const updated = await removeMoodBoardItem(board.id, pinned.id, { silent: true }).catch((err) => {
        toast.error(err?.message || 'Unpin failed');
        return null;
      });
      setBusyId(null);
      if (!updated) return;
      updateBoards((prev) => (prev || []).map((b) => (b.id === board.id ? updated : b)));
      toast.success(`Removed from ${board.name}`);
      return;
    }
    const created = await addMoodBoardItem(board.id, pinPayload, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Pin failed');
      return null;
    });
    setBusyId(null);
    if (!created) return;
    // The add endpoint returns the new item, not the board — merge it into the
    // board's items locally so the checkmark flips without a refetch.
    updateBoards((prev) => (prev || []).map((b) => (
      b.id === board.id ? { ...b, items: [...(Array.isArray(b.items) ? b.items : []), created] } : b
    )));
    toast.success(`Pinned to ${board.name}`);
  }, [mediaKey, pinPayload]);

  const renderItem = (board, { updateCollections }) => {
    const pinned = !!findPinned(board, mediaKey);
    return (
      <button
        key={board.id}
        type="button"
        disabled={busyId === board.id}
        onClick={() => handleTogglePin(board, updateCollections)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-port-border rounded disabled:opacity-50"
        role="menuitemcheckbox"
        aria-checked={pinned}
      >
        <span className="break-words min-w-0 flex-1">{board.name}</span>
        {pinned && <Check className="w-3.5 h-3.5 text-port-success shrink-0" />}
      </button>
    );
  };

  const handleCreated = useCallback(async (created, { addToCollectionsState }) => {
    // Creating a board from this popover means "pin the current item to the new
    // board." Surface the pin failure separately so the user still learns the
    // board exists if only the auto-pin failed.
    let pinError = null;
    const pinnedItem = await addMoodBoardItem(created.id, pinPayload, { silent: true }).catch((err) => {
      pinError = err;
      return null;
    });
    const withItem = pinnedItem
      ? { ...created, items: [...(Array.isArray(created.items) ? created.items : []), pinnedItem] }
      : created;
    addToCollectionsState((prev) => ([...(prev || []), withItem]));
    if (pinError) {
      toast.error(`Created "${created.name}" but failed to pin: ${pinError.message}`);
    } else {
      toast.success(`Pinned to ${created.name}`);
    }
  }, [pinPayload]);

  const sizeCls = SIZES[size] || SIZES.sm;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        className={`shrink-0 ${sizeCls.button} bg-port-border hover:bg-port-border/70 text-white rounded flex items-center justify-center`}
        title="Pin to mood board"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <LayoutGrid className={sizeCls.icon} />
      </button>
      <CollectionPickerShell
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        title="Mood boards"
        width={240}
        minWidth={180}
        emptyMessage="No mood boards yet — create one below."
        newCollectionPlaceholder="New board name"
        createTitle="Create and pin"
        searchPlaceholder="Search boards…"
        renderItem={renderItem}
        onCreated={handleCreated}
        loadItems={listMoodBoards}
        createItem={createMoodBoard}
      />
    </>
  );
}
