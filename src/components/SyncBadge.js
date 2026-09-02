import React from 'react';
import { parseDate } from '../utils';

// Shows whether a session's note has reached the helpdesk. Every save queues a
// sync; the badge reads the bookkeeping columns the server keeps on the session.
export function SyncBadge({ session, compact = false }) {
  const at = session.last_zendesk_sync_at;
  const err = session.last_zendesk_sync_error;
  let kind, label, title;
  if (err) {
    kind = 'error';
    label = compact ? 'Sync failed' : 'Helpdesk sync failed';
    title = err;
  } else if (at) {
    const when = parseDate(at);
    kind = 'synced';
    label = compact ? 'Synced' : `Synced to helpdesk ${when.toLocaleDateString()}`;
    title = `Synced ${when.toLocaleString()}`;
  } else {
    kind = 'pending';
    label = compact ? 'Sync pending' : 'Helpdesk sync pending';
    title = 'Not yet synced to the helpdesk';
  }
  return <span className={`sync-badge sync-badge--${kind}`} title={title}>{label}</span>;
}
