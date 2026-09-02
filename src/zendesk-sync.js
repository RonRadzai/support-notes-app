// Helpdesk sync orchestration.
//
// Keeps one custom-object record in the helpdesk per session note (keyed by the
// note's UUID), creates tickets from a session's issues, and polls linked tickets
// so an issue closes here when its ticket is solved there. All vendor calls go
// through the adapter in src/integrations/zendesk (real or mock, picked by
// MOCK_INTEGRATIONS); this module owns the scheduling, payload shape and the
// bookkeeping columns on the sessions table.

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./database');
const { zendesk, isMock } = require('./integrations');

// ── Config ────────────────────────────────────────────────────────────────────

const CHECKPOINT_KEY         = 'zendesk_reconcile_checkpoint';
const RECONCILE_HOUR         = 3;  // 3 AM daily
const TICKET_POLL_INTERVAL_H = 4;  // check linked ticket statuses every 4 hours
const RESOLUTION_NOTE        = 'The linked helpdesk ticket has been solved';
const ROOT                   = path.join(__dirname, '..');
const ALERT_LOG              = path.resolve(ROOT, process.env.SYNC_ERROR_LOG || path.join('data', 'sync-errors.log'));
const TICKET_TAG             = process.env.ZENDESK_TICKET_TAG || 'support-session';

// Optional numeric ids of ticket custom fields; a blank id skips that field.
const TICKET_FIELDS = {
  customer_name:  process.env.ZENDESK_TICKET_FIELD_CUSTOMER_NAME,
  account_number: process.env.ZENDESK_TICKET_FIELD_ACCOUNT_NUMBER,
  crm_org_id:     process.env.ZENDESK_TICKET_FIELD_CRM_ORG_ID,
};

function zendeskEnabled() {
  return zendesk.isConfigured();
}

// ── Alerting ──────────────────────────────────────────────────────────────────
// Always appends to a local log file. If ALERT_WEBHOOK_URL is set, also POSTs a
// short message to it (any incoming-webhook style endpoint).

async function sendAlert(title, detail) {
  const line = `[${new Date().toISOString()}] ${title}: ${detail}\n`;
  try {
    fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
    fs.appendFileSync(ALERT_LOG, line, 'utf8');
  } catch (e) {
    console.error('[zendesk-sync] Could not write alert log:', e.message);
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Support notes sync: ${title}\n${detail}` }),
    });
  } catch (e) {
    console.error('[zendesk-sync] Webhook alert failed:', e.message);
  }
}

// ── Payload builder ───────────────────────────────────────────────────────────
// Maps one session plus its issues to a custom-object record. Multi-issue sessions
// concatenate the text fields; scalar fields use the first non-empty value.

function buildPayload(session, issues, zdOrgId) {
  const nonEmpty = v => (v != null && String(v).trim() !== '') ? String(v).trim() : null;
  const joinUnique = arr => {
    const u = [...new Set(arr.filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
    return u.length ? u.join(', ') : null;
  };
  const joinMulti = arr => {
    const f = arr.map(v => nonEmpty(v)).filter(Boolean);
    return f.length ? f.join('\n---\n') : null;
  };

  // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC; the record only needs the day.
  const noteDate = session.date_created ? session.date_created.replace(' ', 'T').split('T')[0] : null;

  const fields = {};
  const set = (k, v) => { if (v) fields[k] = v; };

  set('customer_name',     nonEmpty(session.customer_name));
  set('org_name',          nonEmpty(session.org_name));
  set('account_number',    nonEmpty(session.account_number));
  set('customer_email',    nonEmpty(session.customer_email));
  set('crm_org_id',        nonEmpty(session.crm_org_id));
  set('session_notes',     nonEmpty(session.notes));
  set('note_date',         noteDate);
  set('platform',          joinUnique(issues.map(i => i.platform)));
  set('status',            joinUnique(issues.map(i => i.status)));
  set('issue_description', joinMulti(issues.map(i => i.description)));
  set('resolution',        joinMulti(issues.map(i => i.resolution)));
  set('order_number',      joinUnique(issues.map(i => i.order_number)));
  set('escalated_to',      joinUnique(issues.map(i => i.escalation_recipients)));
  set('zendesk_ticket_id', joinUnique(issues.map(i => i.zendesk_ticket)));
  if (zdOrgId) fields.organization = zdOrgId;

  const name = [nonEmpty(session.customer_name), nonEmpty(session.account_number), noteDate].filter(Boolean).join(' | ');

  return { name, external_id: session.note_id, custom_object_fields: fields };
}

// ── Sync one session ──────────────────────────────────────────────────────────
// Calls are serialized per session id. Without this, two near-simultaneous syncs
// for the same session (create a session, then immediately add an issue to it)
// both find no existing record and both create one.

const syncChains = new Map(); // session.id -> tail Promise (never rejects)

function syncToZendesk(session, issues) {
  const key = session.id;
  const prior = syncChains.get(key) || Promise.resolve();
  const result = prior.then(() => syncToZendeskOnce(session, issues));
  const tail = result.catch(() => {});
  syncChains.set(key, tail);
  tail.finally(() => { if (syncChains.get(key) === tail) syncChains.delete(key); });
  return result;
}

async function syncToZendeskOnce(session, issues) {
  const noteId = session.note_id;
  console.log(`[zendesk-sync] Syncing note_id=${noteId} (session ${session.id})`);

  const zdOrgId  = await zendesk.lookupOrgId(session.account_number);
  const existing = await zendesk.findNoteRecord(noteId);
  const record   = buildPayload(session, issues, zdOrgId);

  if (existing) await zendesk.updateNoteRecord(existing.id, record);
  else await zendesk.createNoteRecord(record);

  console.log(`[zendesk-sync] Success note_id=${noteId}`);
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function getCheckpoint() {
  return db.prepare('SELECT value FROM kv_store WHERE key = ?').get(CHECKPOINT_KEY)?.value || '1970-01-01T00:00:00.000Z';
}

function advanceCheckpoint() {
  const ts = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run(CHECKPOINT_KEY, ts);
  console.log(`[zendesk-sync] Reconciliation checkpoint advanced to ${ts}`);
}

// ── Public: sync a single session (fire-and-forget from server.js) ────────────

async function syncSession(sessionId) {
  if (!zendeskEnabled()) return;
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session || session.deleted_at || !session.note_id) return;
    const issues = db.prepare('SELECT * FROM issues WHERE session_id = ?').all(sessionId);

    await syncToZendesk(session, issues);

    db.prepare("UPDATE sessions SET last_zendesk_sync_at = datetime('now'), last_zendesk_sync_error = NULL WHERE id = ?").run(sessionId);
  } catch (e) {
    console.error(`[zendesk-sync] FAILED session ${sessionId}: ${e.message}`);
    try {
      db.prepare("UPDATE sessions SET last_zendesk_sync_at = datetime('now'), last_zendesk_sync_error = ? WHERE id = ?").run(e.message, sessionId);
    } catch {}
    await sendAlert(`Sync failed (session ${sessionId})`, e.message);
  }
}

// ── Public: nightly reconciliation ────────────────────────────────────────────
// Re-syncs every non-deleted session modified since the last successful run. The
// checkpoint only advances when every session succeeded, so a partial failure
// retries from the same point next time.

async function runReconciliation() {
  if (!zendeskEnabled()) return { synced: 0, failed: 0 };

  const checkpoint = getCheckpoint();
  console.log(`[zendesk-sync] Reconciliation started. Checkpoint: ${checkpoint}`);

  const sessions = db.prepare(`
    SELECT * FROM sessions
    WHERE deleted_at IS NULL
      AND note_id IS NOT NULL
      AND (COALESCE(updated_at, date_created) > ? OR last_zendesk_sync_at IS NULL OR last_zendesk_sync_error IS NOT NULL)
    ORDER BY COALESCE(updated_at, date_created) ASC
  `).all(checkpoint);

  if (sessions.length === 0) {
    console.log('[zendesk-sync] Reconciliation: nothing to sync');
    advanceCheckpoint();
    return { synced: 0, failed: 0 };
  }

  console.log(`[zendesk-sync] Reconciliation: ${sessions.length} session(s) to sync`);

  let failures = 0;
  for (const session of sessions) {
    try {
      const issues = db.prepare('SELECT * FROM issues WHERE session_id = ?').all(session.id);
      await syncToZendesk(session, issues);
      db.prepare("UPDATE sessions SET last_zendesk_sync_at = datetime('now'), last_zendesk_sync_error = NULL WHERE id = ?").run(session.id);
    } catch (e) {
      failures++;
      console.error(`[zendesk-sync] Reconciliation FAILED session ${session.id} (note_id=${session.note_id}): ${e.message}`);
      try {
        db.prepare("UPDATE sessions SET last_zendesk_sync_at = datetime('now'), last_zendesk_sync_error = ? WHERE id = ?").run(e.message, session.id);
      } catch {}
    }
  }

  if (failures === 0) {
    advanceCheckpoint();
    console.log(`[zendesk-sync] Reconciliation complete: ${sessions.length} synced, checkpoint advanced`);
  } else {
    const msg = `${failures}/${sessions.length} session(s) failed`;
    console.error(`[zendesk-sync] Reconciliation finished with failures: ${msg}`);
    await sendAlert('Helpdesk reconciliation failures', msg);
  }
  return { synced: sessions.length - failures, failed: failures };
}

function scheduleReconciliation() {
  const now  = new Date();
  const next = new Date();
  next.setHours(RECONCILE_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const timer = setTimeout(() => {
    runReconciliation().catch(e => console.error('[zendesk-sync] Reconciliation error:', e.message));
    setInterval(() => {
      runReconciliation().catch(e => console.error('[zendesk-sync] Reconciliation error:', e.message));
    }, 24 * 60 * 60 * 1000).unref();
  }, next - now);
  timer.unref();

  if (zendeskEnabled()) {
    console.log(`[zendesk-sync] Next reconciliation scheduled at ${next.toLocaleString()} (adapter: ${isMock ? 'mock' : 'real'})`);
  } else {
    console.log('[zendesk-sync] Disabled: set ZENDESK_SUBDOMAIN, ZENDESK_CLIENT_ID and ZENDESK_CLIENT_SECRET, or leave MOCK_INTEGRATIONS=true');
  }
}

// ── Ticket creation ───────────────────────────────────────────────────────────

function formatTicketBody(issues) {
  const lines = [];
  issues.forEach((issue, idx) => {
    lines.push(issues.length > 1 ? `Issue ${idx + 1}: ${issue.platform}` : issue.platform);
    lines.push(issue.description);
    if (issue.order_number) lines.push(`Order #: ${issue.order_number}`);
    if (issue.tags) lines.push(`Tags: ${issue.tags}`);
    if (issue.resolution) lines.push(`Resolution: ${issue.resolution}`);
    if (idx < issues.length - 1) lines.push('\n---\n');
  });
  return lines.join('\n');
}

async function createZendeskTicket(session, issues, subject) {
  const zdOrgId = await zendesk.lookupOrgId(session.account_number);

  const ticket = {
    subject,
    comment: { body: formatTicketBody(issues), public: false }, // internal note: no customer email until an agent replies
    tags: [TICKET_TAG],
    status: 'new',
  };

  if (session.customer_name || session.customer_email) {
    ticket.requester = {
      name: session.customer_name || session.customer_email,
      ...(session.customer_email && { email: session.customer_email }),
    };
  }
  if (zdOrgId) ticket.organization_id = zdOrgId;

  const customFields = [];
  if (TICKET_FIELDS.customer_name)  customFields.push({ id: Number(TICKET_FIELDS.customer_name),  value: session.customer_name || null });
  if (TICKET_FIELDS.account_number) customFields.push({ id: Number(TICKET_FIELDS.account_number), value: session.account_number ? parseInt(session.account_number, 10) : null });
  if (TICKET_FIELDS.crm_org_id)     customFields.push({ id: Number(TICKET_FIELDS.crm_org_id),     value: session.crm_org_id || null });
  if (customFields.length) ticket.custom_fields = customFields;

  const { id, url } = await zendesk.createTicket(ticket);
  return { ticket_id: String(id), ticket_url: url };
}

// ── Ticket status polling ─────────────────────────────────────────────────────
// For every open issue with a linked ticket, ask the helpdesk for the ticket's
// status. Solved or closed tickets mark the issue Solved here too.

async function pollTicketStatuses() {
  if (!zendeskEnabled()) return { resolved: 0 };

  const issues = db.prepare(`
    SELECT id, session_id, zendesk_ticket, resolution
    FROM issues
    WHERE zendesk_ticket IS NOT NULL AND zendesk_ticket != '' AND status != 'Solved'
  `).all();

  if (issues.length === 0) {
    console.log('[zendesk-sync] Ticket poll: no open linked tickets to check');
    return { resolved: 0 };
  }

  const ticketMap = new Map(); // ticket id -> issues sharing it
  for (const issue of issues) {
    const group = ticketMap.get(issue.zendesk_ticket) || [];
    group.push(issue);
    ticketMap.set(issue.zendesk_ticket, group);
  }

  console.log(`[zendesk-sync] Ticket poll: checking ${ticketMap.size} ticket(s) for ${issues.length} issue(s)`);

  let resolved = 0;
  for (const [ticketId, affected] of ticketMap) {
    try {
      const status = await zendesk.getTicketStatus(ticketId);
      if (status === null) { console.warn(`[zendesk-sync] Ticket ${ticketId} not found (may have been deleted)`); continue; }
      if (status !== 'solved' && status !== 'closed') continue;

      for (const issue of affected) {
        db.prepare(`
          UPDATE issues
          SET status = 'Solved',
              resolution = CASE WHEN (resolution IS NULL OR resolution = '') THEN ? ELSE resolution END
          WHERE id = ? AND status != 'Solved'
        `).run(RESOLUTION_NOTE, issue.id);
        resolved++;
        console.log(`[zendesk-sync] Issue ${issue.id} marked Solved (ticket ${ticketId} is ${status})`);
        setImmediate(() => syncSession(issue.session_id));
      }
    } catch (e) {
      console.error(`[zendesk-sync] Ticket poll error for ticket ${ticketId}: ${e.message}`);
    }
  }

  if (resolved > 0) console.log(`[zendesk-sync] Ticket poll complete: ${resolved} issue(s) marked Solved`);
  return { resolved };
}

function scheduleTicketPoll() {
  if (!zendeskEnabled()) return;
  const intervalMs = TICKET_POLL_INTERVAL_H * 60 * 60 * 1000;
  // First run one minute after start, then every TICKET_POLL_INTERVAL_H hours.
  setTimeout(() => {
    pollTicketStatuses().catch(e => console.error('[zendesk-sync] Ticket poll error:', e.message));
    setInterval(() => {
      pollTicketStatuses().catch(e => console.error('[zendesk-sync] Ticket poll error:', e.message));
    }, intervalMs).unref();
  }, 60 * 1000).unref();
  console.log(`[zendesk-sync] Ticket status poll scheduled every ${TICKET_POLL_INTERVAL_H}h`);
}

module.exports = {
  syncSession, runReconciliation, scheduleReconciliation,
  createZendeskTicket, pollTicketStatuses, scheduleTicketPoll,
  zendeskEnabled, buildPayload, ALERT_LOG,
};
