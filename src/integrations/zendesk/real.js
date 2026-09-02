// Zendesk adapter (real). OAuth2 client-credentials grant; token cached in memory.
//
// Interface (shared with mock.js):
//   isConfigured()                      true when subdomain, client id and secret are set
//   ticketUrlBase()                     agent-facing URL prefix for a ticket id
//   lookupOrgId(accountNumber)          Zendesk organization id for an internal account number, or null
//   findNoteRecord(noteId)              { id } of the custom-object record with that external id, or null
//   createNoteRecord(record)            create a custom-object record, returns { id }
//   updateNoteRecord(recordId, record)  replace the fields of an existing record
//   createTicket(ticket)                create a ticket, returns { id, url }
//   getTicketStatus(ticketId)           'new' | 'open' | 'pending' | 'solved' | 'closed' | ..., or null if not found
//
// Every endpoint, key and field name comes from the environment (see .env.example).
// Zendesk retired email + API-token Basic auth in favor of OAuth; this module
// authenticates as a confidential OAuth client (no interactive user), caches the
// bearer token until shortly before it expires, and refreshes once on a 401.
// https://developer.zendesk.com/api-reference/ticketing/oauth/grant_type_tokens/

'use strict';

const https = require('https');

const subdomain   = () => process.env.ZENDESK_SUBDOMAIN;
const hostname    = () => `${subdomain()}.zendesk.com`;
const OAUTH_SCOPE = () => process.env.ZENDESK_OAUTH_SCOPE || 'read write';
const OBJECT_KEY  = () => process.env.ZENDESK_NOTES_OBJECT_KEY || 'session_notes';
const ORG_FIELD   = () => process.env.ZENDESK_ORG_ACCOUNT_FIELD || 'account_number';
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

function isConfigured() {
  return !!(process.env.ZENDESK_SUBDOMAIN && process.env.ZENDESK_CLIENT_ID && process.env.ZENDESK_CLIENT_SECRET);
}

function ticketUrlBase() {
  return `https://${hostname()}/agent/tickets`;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

let cachedToken = null; // { accessToken, expiresAt }

function invalidateToken() { cachedToken = null; }

async function fetchAccessToken() {
  const payload = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.ZENDESK_CLIENT_ID,
    client_secret: process.env.ZENDESK_CLIENT_SECRET,
    scope: OAUTH_SCOPE(),
  });
  const r = await httpsRequest({ hostname: hostname(), path: '/oauth/tokens', method: 'POST', headers: { 'Content-Type': 'application/json' } }, payload);
  if (r.statusCode !== 200 || !r.body?.access_token) {
    throw new Error(`OAuth token request failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
  }
  const expiresInMs = (r.body.expires_in || 3600) * 1000;
  cachedToken = { accessToken: r.body.access_token, expiresAt: Date.now() + expiresInMs };
  return cachedToken.accessToken;
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) return cachedToken.accessToken;
  return fetchAccessToken();
}

async function authHeaders() {
  return { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, headers: { ...options.headers } };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { body = raw; }
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Retry with exponential backoff. 429 waits and retries; 401 refreshes the token and retries once.
async function withRetry(fn, maxAttempts, label) {
  let lastErr;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const r = await fn();
      if (r.statusCode === 429) {
        const wait = Math.pow(2, i) * 2000;
        console.warn(`[zendesk] Rate limited attempt ${i}/${maxAttempts}, waiting ${wait}ms: ${label}`);
        await sleep(wait);
        lastErr = new Error('429 Rate Limited');
        continue;
      }
      if (r.statusCode === 401 && i < maxAttempts) {
        console.warn(`[zendesk] 401, refreshing OAuth token and retrying: ${label}`);
        invalidateToken();
        lastErr = new Error('401 Unauthorized');
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < maxAttempts) {
        const wait = Math.pow(2, i) * 1000;
        console.warn(`[zendesk] Attempt ${i} failed (${e.message}), retrying in ${wait}ms: ${label}`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('Max retries exceeded');
}

async function api(method, path, body, label) {
  return withRetry(
    async () => httpsRequest({ hostname: hostname(), path, method, headers: await authHeaders() }, body ? JSON.stringify(body) : null),
    3, label
  );
}

// ── Organizations ─────────────────────────────────────────────────────────────

async function lookupOrgId(accountNumber) {
  if (!accountNumber) return null;
  try {
    const query = encodeURIComponent(`type:organization ${ORG_FIELD()}:${accountNumber}`);
    const r = await api('GET', `/api/v2/search?query=${query}`, null, `org lookup account_number=${accountNumber}`);
    if (r.statusCode === 200 && r.body?.results?.length > 0) return r.body.results[0].id;
  } catch (e) {
    console.warn(`[zendesk] Org lookup failed for account_number=${accountNumber}: ${e.message}`);
  }
  return null;
}

// ── Custom object records (one per session note) ──────────────────────────────

async function findNoteRecord(noteId) {
  const r = await api('GET', `/api/v2/custom_objects/${OBJECT_KEY()}/records?filter[external_ids]=${encodeURIComponent(noteId)}`, null, `lookup note_id=${noteId}`);
  if (r.statusCode !== 200) throw new Error(`Lookup failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
  const existing = r.body?.custom_object_records?.[0];
  return existing ? { id: existing.id } : null;
}

async function createNoteRecord(record) {
  const r = await api('POST', `/api/v2/custom_objects/${OBJECT_KEY()}/records`, { custom_object_record: record }, `create note_id=${record.external_id}`);
  if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`Create failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
  return { id: r.body?.custom_object_record?.id };
}

async function updateNoteRecord(recordId, record) {
  const r = await api('PATCH', `/api/v2/custom_objects/${OBJECT_KEY()}/records/${recordId}`, { custom_object_record: record }, `update note_id=${record.external_id}`);
  if (r.statusCode < 200 || r.statusCode >= 300) throw new Error(`Update failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
}

// ── Tickets ───────────────────────────────────────────────────────────────────

async function createTicket(ticket) {
  const r = await api('POST', '/api/v2/tickets', { ticket }, `create ticket "${ticket.subject}"`);
  if (r.statusCode !== 201) throw new Error(`Ticket creation failed (${r.statusCode}): ${JSON.stringify(r.body)}`);
  const id = r.body.ticket.id;
  return { id: String(id), url: `${ticketUrlBase()}/${id}` };
}

async function getTicketStatus(ticketId) {
  const r = await api('GET', `/api/v2/tickets/${ticketId}`, null, `poll ticket ${ticketId}`);
  if (r.statusCode === 404) return null;
  if (r.statusCode !== 200) throw new Error(`Ticket ${ticketId} fetch returned ${r.statusCode}`);
  return r.body?.ticket?.status ?? null;
}

module.exports = { isConfigured, ticketUrlBase, lookupOrgId, findNoteRecord, createNoteRecord, updateNoteRecord, createTicket, getTicketStatus };
