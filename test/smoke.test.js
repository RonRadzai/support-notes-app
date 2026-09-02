// Smoke tests for the API against the mock helpdesk adapter.
// Boots the real Express app on an ephemeral port with a throwaway data directory.
// Run with: npm run test:server

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'support-notes-test-'));
process.env.NODE_ENV = 'test';
process.env.MOCK_INTEGRATIONS = 'true';
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.ORGS_CSV_PATH = path.join(tmp, 'orgs.csv');
process.env.USERS_CSV_PATH = path.join(tmp, 'users.csv');
process.env.SCREENSHOT_DIR = path.join(tmp, 'screenshots');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.RECIPIENTS_PATH = path.join(tmp, 'recipients.json');
process.env.SYNC_ERROR_LOG = path.join(tmp, 'sync-errors.log');

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  require('../src/database').close(); // release the SQLite lock so the directory can be removed on Windows
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function call(method, route, body) {
  const res = await fetch(baseUrl + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const customer = {
  customer_name: 'Test Person',
  org_name: 'Test Organization',
  account_number: '99001',
  crm_org_id: 'CRM-TEST1',
  customer_email: 'test.person@example.com',
  notes: 'Smoke test session',
};
let sessionId;
let issueId;

test('GET /api/config reports mock integrations and a ticket URL base', async () => {
  const res = await call('GET', '/api/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mock_integrations, true);
  assert.strictEqual(res.body.helpdesk_enabled, true);
  assert.match(res.body.ticket_url_base, /^https:\/\//);
});

test('GET /api/platforms returns the default platforms', async () => {
  const res = await call('GET', '/api/platforms');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.length >= 4);
  assert.strictEqual(res.body[0].name, 'Web App');
});

test('POST /api/sessions validates input', async () => {
  const res = await call('POST', '/api/sessions', { ...customer, customer_name: '' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Customer name/);
});

test('POST /api/sessions creates a session and appends the organization and contact to the lookup files', async () => {
  const res = await call('POST', '/api/sessions', customer);
  assert.strictEqual(res.status, 200);
  assert.ok(Number.isInteger(res.body.id));
  assert.deepStrictEqual(res.body.warnings, []);
  sessionId = res.body.id;

  const orgs = await call('GET', '/api/orgs');
  assert.ok(orgs.body.some(o => o.account_number === '99001' && o.name === 'Test Organization'));
  const users = await call('GET', '/api/users');
  assert.ok(users.body.some(u => u.customer_email === 'test.person@example.com'));
});

test('POST /api/sessions warns on a conflicting organization name for a known account number', async () => {
  const res = await call('POST', '/api/sessions', { ...customer, org_name: 'Different Name' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.warnings.length, 1);
  assert.match(res.body.warnings[0], /Lookup conflict/);
  await call('DELETE', `/api/sessions/${res.body.id}`);
});

test('POST /api/issues adds an issue to the session', async () => {
  const res = await call('POST', '/api/issues', {
    session_id: sessionId, platform: 'Web App', tags: 'login',
    description: 'Cannot log in after password reset.', status: 'Pending',
  });
  assert.strictEqual(res.status, 200);
  issueId = res.body.id;

  const session = await call('GET', `/api/sessions/${sessionId}`);
  assert.strictEqual(session.body.issues.length, 1);
  assert.strictEqual(session.body.issues[0].status, 'Pending');
});

test('POST /api/sessions/:id/sync pushes the note to the mock helpdesk', async () => {
  const res = await call('POST', `/api/sessions/${sessionId}/sync`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.last_zendesk_sync_at);
  assert.strictEqual(res.body.last_zendesk_sync_error, null);

  const session = await call('GET', `/api/sessions/${sessionId}`);
  const records = await call('GET', '/api/helpdesk/records');
  const record = records.body.records.find(r => r.external_id === session.body.note_id);
  assert.ok(record, 'note record should exist in the mock helpdesk');
  assert.strictEqual(record.custom_object_fields.customer_name, 'Test Person');
  assert.match(record.custom_object_fields.issue_description, /Cannot log in/);
});

test('POST /api/zendesk/create-ticket links a ticket to the issue', async () => {
  const res = await call('POST', '/api/zendesk/create-ticket', { session_id: sessionId, issue_ids: [issueId], subject: 'Follow up' });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.ticket_id, /^\d+$/);
  assert.ok(res.body.ticket_url.endsWith(`/${res.body.ticket_id}`));

  const session = await call('GET', `/api/sessions/${sessionId}`);
  assert.strictEqual(session.body.issues[0].zendesk_ticket, res.body.ticket_id);
});

test('GET /api/search finds the session by organization and by issue text', async () => {
  const byOrg = await call('GET', '/api/search?query=Test%20Organization');
  assert.ok(byOrg.body.some(s => s.id === sessionId));
  const byIssue = await call('GET', '/api/search?query=password%20reset');
  assert.ok(byIssue.body.some(s => s.id === sessionId));
});

test('DELETE /api/sessions/:id moves the session to the recycle bin and restore brings it back', async () => {
  await call('DELETE', `/api/sessions/${sessionId}`);
  assert.strictEqual((await call('GET', `/api/sessions/${sessionId}`)).status, 404);
  const bin = await call('GET', '/api/recycle-bin');
  assert.ok(bin.body.some(s => s.id === sessionId));
  await call('POST', `/api/recycle-bin/${sessionId}/restore`);
  assert.strictEqual((await call('GET', `/api/sessions/${sessionId}`)).status, 200);
});

test('POST /api/zendesk-sync/run reconciles without errors', async () => {
  const res = await call('POST', '/api/zendesk-sync/run?force=true');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.failed, 0);
  const status = await call('GET', '/api/zendesk-sync/status');
  assert.strictEqual(status.body.error_sessions.length, 0);
});
