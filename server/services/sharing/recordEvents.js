/**
 * Cross-service event bus for record mutations the sharing subsystem
 * cares about. Each pipeline / universe write path emits `updated` with
 * `{ recordKind, recordId }` after a successful persist; subscriptions.js
 * listens and re-exports the record into any bucket it's currently
 * subscribed to.
 *
 * Kept separate from the service modules so importing this bus doesn't
 * drag in the heavyweight pipeline graph.
 */

import { EventEmitter } from 'events';

export const recordEvents = new EventEmitter();
// Many subscriptions per record + the subscriptions listener itself can
// add up past the default 10-listener warning threshold under load.
recordEvents.setMaxListeners(100);

/** Fire-and-forget — listeners' failures shouldn't poison the caller. */
export function emitRecordUpdated(recordKind, recordId) {
  if (!recordKind || !recordId) return;
  recordEvents.emit('updated', { recordKind, recordId });
}
