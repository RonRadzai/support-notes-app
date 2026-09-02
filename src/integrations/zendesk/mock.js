// Zendesk adapter (mock). An in-memory helpdesk seeded from fixtures/zendesk.json.
//
// Same interface as real.js. Note records and tickets created through the app
// live in memory until the API process restarts; the sessions table keeps the
// durable record of what synced and when. Two extra read-only helpers,
// listNoteRecords() and listTickets(), let the UI and tests inspect the mock.

'use strict';

const fixture = require('../fixtures/zendesk.json');
const { daysAgoIso } = require('../fixtures/clock');

const TICKET_URL_BASE = fixture.ticket_url_base;

const orgsByAccount = new Map(fixture.organizations.map(o => [String(o.account_number), o]));

const tickets = new Map();
let nextTicketId = 0;
for (const t of fixture.tickets) {
  tickets.set(String(t.id), {
    id: t.id,
    subject: t.subject,
    status: t.status,
    requester_email: t.requester_email,
    created_at: daysAgoIso(t.created_days_ago),
    updated_at: daysAgoIso(t.updated_days_ago ?? t.created_days_ago),
  });
  nextTicketId = Math.max(nextTicketId, t.id + 1);
}

const noteRecords = new Map(); // external_id -> { id, external_id, name, custom_object_fields, created_at, updated_at }
let nextRecordId = 1;

// A little latency makes the "syncing" state visible in the UI without slowing tests down much.
const LATENCY_MS = 120;
const later = v => new Promise(resolve => setTimeout(() => resolve(v), LATENCY_MS));

const isConfigured = () => true;
const ticketUrlBase = () => TICKET_URL_BASE;

async function lookupOrgId(accountNumber) {
  const org = orgsByAccount.get(String(accountNumber || '').trim());
  return later(org ? org.id : null);
}

async function findNoteRecord(noteId) {
  const r = noteRecords.get(noteId);
  return later(r ? { id: r.id } : null);
}

async function createNoteRecord(record) {
  const now = new Date().toISOString();
  const stored = { id: `01J${String(nextRecordId++).padStart(6, '0')}`, ...record, created_at: now, updated_at: now };
  noteRecords.set(record.external_id, stored);
  return later({ id: stored.id });
}

async function updateNoteRecord(recordId, record) {
  const existing = [...noteRecords.values()].find(r => r.id === recordId);
  if (!existing) throw new Error(`Record ${recordId} not found`);
  Object.assign(existing, record, { updated_at: new Date().toISOString() });
  return later(undefined);
}

async function createTicket(ticket) {
  const id = nextTicketId++;
  const now = new Date().toISOString();
  tickets.set(String(id), {
    id,
    subject: ticket.subject,
    status: ticket.status || 'new',
    requester_email: ticket.requester?.email || null,
    organization_id: ticket.organization_id || null,
    tags: ticket.tags || [],
    body: ticket.comment?.body || '',
    created_at: now,
    updated_at: now,
  });
  return later({ id: String(id), url: `${TICKET_URL_BASE}/${id}` });
}

async function getTicketStatus(ticketId) {
  return later(tickets.get(String(ticketId))?.status ?? null);
}

function listNoteRecords() {
  return [...noteRecords.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function listTickets() {
  return [...tickets.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = { isConfigured, ticketUrlBase, lookupOrgId, findNoteRecord, createNoteRecord, updateNoteRecord, createTicket, getTicketStatus, listNoteRecords, listTickets };
