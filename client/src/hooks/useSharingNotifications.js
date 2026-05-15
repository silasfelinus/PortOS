import { useEffect } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

/**
 * Global subscriber for share-bucket notifications. Mirrors useErrorNotifications:
 * mounts once in Layout.jsx so any open page hears about auto-merge updates
 * regardless of where the user is in the app.
 *
 * The Sharing page itself does NOT need to toast — it already lists incoming
 * activity in its own UI. We suppress the toast when the user is on /sharing
 * to avoid the duplicate.
 */
export function useSharingNotifications() {
  useEffect(() => {
    const onManifestProcessed = (payload) => {
      const overridden = payload?.outcome?.overridden;
      if (!Array.isArray(overridden) || overridden.length === 0) return;
      if (typeof window !== 'undefined' && window.location?.pathname?.startsWith('/sharing')) return;
      const labels = overridden
        .slice(0, 3)
        .map((o) => `${o.kind === 'issue' ? 'Issue' : o.kind === 'universe' ? 'Universe' : 'Series'} "${o.label || o.id}"`);
      const more = overridden.length > 3 ? ` (+${overridden.length - 3} more)` : '';
      toast(`Auto-merged: ${labels.join(', ')}${more}`, {
        icon: '🔄',
        duration: 8000,
      });
    };
    socket.on('sharing:manifest-processed', onManifestProcessed);
    return () => {
      socket.off('sharing:manifest-processed', onManifestProcessed);
    };
  }, []);
}
