// Express API for Support Session Notes.
//
// One process serves the JSON API, uploaded screenshots and (when build/ exists)
// the compiled React UI. Helpdesk calls go through src/zendesk-sync.js, which in
// turn uses the adapter picked by MOCK_INTEGRATIONS (see src/integrations).

require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const db = require('./database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const integrations = require('./integrations');
const { zendesk } = integrations;
const { syncSession, scheduleReconciliation, runReconciliation, createZendeskTicket, scheduleTicketPoll, pollTicketStatuses, zendeskEnabled, ALERT_LOG } = require('./zendesk-sync');

const app = express();
app.set('trust proxy', 1); // one hop: the CRA dev proxy or a reverse proxy in front of the API
const PORT = process.env.PORT || 3001;
const ROOT = path.join(__dirname, '..');
const resolveData = (envValue, fallback) => path.resolve(ROOT, envValue || path.join('data', fallback));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

// Security headers. CSP is off because the CRA build uses inline scripts; HSTS is off
// because the app is meant for an internal network, usually plain HTTP.
app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: false }));

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '50kb' }));

// Some reverse proxies append the client port to X-Forwarded-For ("10.1.2.3:53262"),
// which express-rate-limit rejects as an invalid IP key. Strip the port for IPv4 only
// (IPv6 colons are part of the address), then run the result through the library's
// own ipKeyGenerator so IPv6 clients still get subnet-masked.
function rateLimitKey(req) {
  const ip = req.ip || '';
  const stripped = ip.includes('.') ? ip.replace(/:\d+$/, '') : ip;
  return rateLimit.ipKeyGenerator(stripped);
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests. Please try again later.' }
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests. Please try again later.' }
});

app.use(generalLimiter);

// ── Input validation helpers ─────────────────────────────────────────────────

const VALID_STATUSES = ['Pending', 'Flagged for Review', 'Escalated', 'Solved'];

function validateSession({ customer_name, org_name, account_number, crm_org_id, customer_email }) {
  if (!customer_name?.trim()) return 'Customer name is required';
  if (customer_name.length > 200) return 'Customer name too long (max 200 chars)';
  if (!org_name?.trim()) return 'Organization name is required';
  if (org_name.length > 200) return 'Organization name too long (max 200 chars)';
  if (account_number && account_number.length > 100) return 'Account number too long';
  if (crm_org_id && crm_org_id.length > 100) return 'CRM Org ID too long';
  if (customer_email && customer_email.length > 200) return 'Email address too long';
  if (customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) return 'Invalid email address';
  return null;
}

// Optional client-supplied note date. Absent or empty means "use the server clock".
// When present it must be a bare YYYY-MM-DD and not in the future.
function validateSessionDate(date_created) {
  if (date_created == null || date_created === '') return null;
  if (typeof date_created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date_created)) return 'Invalid date (expected YYYY-MM-DD)';
  const today = db.prepare("SELECT date('now') AS d").get().d;
  if (date_created > today) return 'Date cannot be in the future';
  return null;
}

function validateIssue({ platform, description, status, tags, resolution, order_number }) {
  if (!platform?.trim()) return 'Platform is required';
  if (platform.length > 100) return 'Platform name too long';
  if (!description?.trim()) return 'Description is required';
  if (description.length > 10000) return 'Description too long (max 10,000 chars)';
  if (status && !VALID_STATUSES.includes(status)) return 'Invalid status value';
  if (tags && tags.length > 500) return 'Tags too long';
  if (resolution && resolution.length > 10000) return 'Resolution too long (max 10,000 chars)';
  if (order_number && order_number.length > 500) return 'Order number too long';
  return null;
}

// ── File upload setup ────────────────────────────────────────────────────────

const uploadDir = resolveData(process.env.SCREENSHOT_DIR, 'screenshots');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/screenshots', express.static(uploadDir));

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.heic']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + path.basename(file.originalname).replace(/[^\w.-]/g, '_'))
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXTENSIONS.has(ext)) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter });

// ── Shared queries ───────────────────────────────────────────────────────────

const selectIssues   = db.prepare('SELECT * FROM issues WHERE session_id = ? ORDER BY id');
const selectComments = db.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY date_created ASC');

function hydrate(session) {
  session.issues = selectIssues.all(session.id);
  session.issues.forEach(issue => { issue.comments = selectComments.all(issue.id); });
  return session;
}

// ── Runtime config for the UI ────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    mock_integrations: integrations.isMock,
    helpdesk_enabled: zendeskEnabled(),
    ticket_url_base: zendesk.ticketUrlBase(),
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions/:id', (req, res) => {
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(hydrate(session));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions', (req, res) => {
  try {
    const sessions = db.prepare('SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY date_created DESC').all();
    res.json(sessions.map(hydrate));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions', writeLimiter, (req, res) => {
  try {
    const { customer_name, org_name, account_number, crm_org_id, customer_email, notes, date_created } = req.body;
    const err = validateSession({ customer_name, org_name, account_number, crm_org_id, customer_email });
    if (err) return res.status(400).json({ error: err });
    if (notes && notes.length > 5000) return res.status(400).json({ error: 'Notes too long (max 5,000 chars)' });
    const dateErr = validateSessionDate(date_created);
    if (dateErr) return res.status(400).json({ error: dateErr });

    // A chosen date is stored at noon UTC so it renders on the same calendar day in
    // US timezones; no override keeps the full-precision server timestamp.
    const hasDate = typeof date_created === 'string' && date_created !== '';
    const result = db.prepare(`
      INSERT INTO sessions (note_id, customer_name, org_name, account_number, crm_org_id, customer_email, notes, date_created, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${hasDate ? '?' : "datetime('now')"}, datetime('now'))
    `).run(randomUUID(), customer_name, org_name, account_number || '', crm_org_id, customer_email, notes, ...(hasDate ? [`${date_created} 12:00:00`] : []));

    const warnings = syncLookups({ customer_name, org_name, account_number, crm_org_id, customer_email });
    res.json({ id: result.lastInsertRowid, warnings });
    setImmediate(() => syncSession(result.lastInsertRowid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/sessions/:id', writeLimiter, (req, res) => {
  try {
    const { customer_name, org_name, account_number, crm_org_id, customer_email, notes, date_created } = req.body;
    const err = validateSession({ customer_name, org_name, account_number, crm_org_id, customer_email });
    if (err) return res.status(400).json({ error: err });
    if (notes && notes.length > 5000) return res.status(400).json({ error: 'Notes too long (max 5,000 chars)' });
    const dateErr = validateSessionDate(date_created);
    if (dateErr) return res.status(400).json({ error: dateErr });

    // Only touch date_created when a new date is supplied; otherwise keep the original timestamp.
    const hasDate = typeof date_created === 'string' && date_created !== '';
    db.prepare(`
      UPDATE sessions
      SET customer_name = ?, org_name = ?, account_number = ?, crm_org_id = ?, customer_email = ?, notes = ?${hasDate ? ', date_created = ?' : ''}, updated_at = datetime('now')
      WHERE id = ?
    `).run(customer_name, org_name, account_number || '', crm_org_id, customer_email, notes, ...(hasDate ? [`${date_created} 12:00:00`] : []), req.params.id);

    const warnings = syncLookups({ customer_name, org_name, account_number, crm_org_id, customer_email });
    res.json({ success: true, warnings });
    setImmediate(() => syncSession(parseInt(req.params.id, 10)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Soft delete: moves the session to the recycle bin.
app.delete('/api/sessions/:id', writeLimiter, (req, res) => {
  try {
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Push one session to the helpdesk now and report the result.
app.post('/api/sessions/:id/sync', writeLimiter, async (req, res) => {
  try {
    if (!zendeskEnabled()) return res.status(503).json({ error: 'Helpdesk integration is not configured on the server.' });
    const id = parseInt(req.params.id, 10);
    const exists = db.prepare('SELECT id FROM sessions WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!exists) return res.status(404).json({ error: 'Session not found' });
    await syncSession(id);
    const s = db.prepare('SELECT last_zendesk_sync_at, last_zendesk_sync_error FROM sessions WHERE id = ?').get(id);
    res.json({ success: !s.last_zendesk_sync_error, ...s });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Issues ───────────────────────────────────────────────────────────────────

app.post('/api/issues', writeLimiter, upload.array('screenshots'), (req, res) => {
  try {
    const { session_id, platform, tags, description, status, resolution, order_number, zendesk_ticket } = req.body;
    const err = validateIssue({ platform, description, status, tags, resolution, order_number });
    if (err) return res.status(400).json({ error: err });
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(session_id)) return res.status(404).json({ error: 'Session not found' });

    const screenshots = req.files ? req.files.map(f => f.filename).join(',') : '';
    const result = db.prepare(`
      INSERT INTO issues (session_id, platform, tags, description, status, resolution, order_number, screenshots, zendesk_ticket, date_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(session_id, platform, tags, description, status || 'Pending', resolution, order_number, screenshots, zendesk_ticket || null);

    res.json({ id: result.lastInsertRowid });
    setImmediate(() => syncSession(parseInt(session_id, 10)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/issues/:id', writeLimiter, upload.array('screenshots'), (req, res) => {
  try {
    const { platform, tags, description, status, resolution, order_number, escalation_recipients, zendesk_ticket } = req.body;
    const err = validateIssue({ platform, description, status, tags, resolution, order_number });
    if (err) return res.status(400).json({ error: err });

    let screenshots = req.body.existing_screenshots || '';
    if (req.files && req.files.length > 0) {
      const added = req.files.map(f => f.filename).join(',');
      screenshots = screenshots ? screenshots + ',' + added : added;
    }

    db.prepare(`
      UPDATE issues
      SET platform = ?, tags = ?, description = ?, status = ?, resolution = ?, order_number = ?, screenshots = ?, escalation_recipients = ?, zendesk_ticket = ?
      WHERE id = ?
    `).run(platform, tags, description, status, resolution, order_number, screenshots, escalation_recipients, zendesk_ticket || null, req.params.id);

    const updated = db.prepare('SELECT session_id FROM issues WHERE id = ?').get(req.params.id);
    if (updated) db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(updated.session_id);
    res.json({ success: true });
    if (updated) setImmediate(() => syncSession(updated.session_id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hard delete of one issue and its screenshot files.
app.delete('/api/issues/:id', writeLimiter, (req, res) => {
  try {
    const issue = db.prepare('SELECT session_id, screenshots FROM issues WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM issues WHERE id = ?').run(req.params.id);
    if (issue) {
      removeScreenshotFiles(issue.screenshots);
      db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(issue.session_id);
      setImmediate(() => syncSession(issue.session_id));
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Comments ─────────────────────────────────────────────────────────────────

app.get('/api/issues/:id/comments', (req, res) => {
  try {
    res.json(selectComments.all(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/issues/:id/comments', writeLimiter, (req, res) => {
  try {
    const { author, body } = req.body;
    if (!author || !author.trim()) return res.status(400).json({ error: 'Author is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body is required' });
    if (author.length > 100) return res.status(400).json({ error: 'Author name too long' });
    if (body.length > 2000) return res.status(400).json({ error: 'Comment too long' });
    const result = db.prepare("INSERT INTO comments (issue_id, author, body, date_created) VALUES (?, ?, ?, datetime('now'))")
      .run(req.params.id, author.trim(), body.trim());
    res.json(db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/comments/:id', writeLimiter, (req, res) => {
  try {
    db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Escalation ───────────────────────────────────────────────────────────────
// Builds a mailto: link the browser opens in the agent's email client, and records
// who the issue was escalated to.

app.post('/api/escalate', writeLimiter, (req, res) => {
  try {
    const { issue_id, recipients } = req.body;
    if (!recipients || typeof recipients !== 'string') return res.status(400).json({ error: 'Recipients are required' });
    if (recipients.length > 1000) return res.status(400).json({ error: 'Recipients list too long' });
    if (/['"\\`\n\r;|&<>]/.test(recipients)) return res.status(400).json({ error: 'Invalid recipient addresses' });

    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issue_id);
    const session = issue && db.prepare('SELECT * FROM sessions WHERE id = ?').get(issue.session_id);
    if (!issue || !session) return res.status(404).json({ error: 'Issue or session not found' });

    const emailBody = [
      `Escalation: ${session.org_name}`,
      '',
      `Organization Name: ${session.org_name}`,
      `Account Number: ${session.account_number}`,
      session.crm_org_id ? `CRM Org ID: ${session.crm_org_id}` : null,
      issue.order_number ? `Order Number: ${issue.order_number}` : null,
      '',
      'Issue Description:',
      issue.description,
      '',
      `Platform: ${issue.platform}`,
      issue.tags ? `Tags: ${issue.tags}` : null,
    ].filter(l => l !== null).join('\n');

    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const acct = session.account_number ? ` - Acct# ${session.account_number}` : '';
    const subject = `Support Escalation: ${session.org_name}${acct} - ${today}`;
    const mailto = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;

    db.prepare('UPDATE issues SET escalation_recipients = ? WHERE id = ?').run(recipients, issue_id);
    res.json({ success: true, mailto });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const recipientsPath = resolveData(process.env.RECIPIENTS_PATH, 'recipients.json');

// Fictional defaults; edit data/recipients.json to change them without a redeploy.
const DEFAULT_RECIPIENTS = [
  { label: 'Tier 2 Support', email: 'tier2-support@example.com' },
  { label: 'Engineering On-call', email: 'engineering-oncall@example.com' },
  { label: 'Billing Team', email: 'billing@example.com' },
  { label: 'IT Helpdesk', email: 'it-helpdesk@example.com' },
];

function loadRecipients() {
  try {
    if (fs.existsSync(recipientsPath)) return JSON.parse(fs.readFileSync(recipientsPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read recipients file, using defaults:', e.message);
  }
  try { fs.writeFileSync(recipientsPath, JSON.stringify(DEFAULT_RECIPIENTS, null, 2), 'utf8'); } catch {}
  return DEFAULT_RECIPIENTS;
}

app.get('/api/recipients', (req, res) => res.json(loadRecipients()));

// ── Recycle bin ──────────────────────────────────────────────────────────────

function removeScreenshotFiles(screenshotsStr) {
  if (!screenshotsStr) return;
  screenshotsStr.split(',').filter(Boolean).forEach(entry => {
    const filePath = path.join(uploadDir, path.basename(entry));
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
    catch (e) { console.error('Failed to delete screenshot file:', filePath, e.message); }
  });
}

app.get('/api/recycle-bin', (req, res) => {
  try {
    const sessions = db.prepare('SELECT * FROM sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
    sessions.forEach(s => { s.issues = selectIssues.all(s.id); });
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recycle-bin/:id/restore', writeLimiter, (req, res) => {
  try {
    db.prepare('UPDATE sessions SET deleted_at = NULL WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/recycle-bin/:id', writeLimiter, (req, res) => {
  try {
    const issues = db.prepare('SELECT screenshots FROM issues WHERE session_id = ?').all(req.params.id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
    issues.forEach(issue => removeScreenshotFiles(issue.screenshots));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Search ───────────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  try {
    const { query } = req.query;
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Query is required' });
    if (query.length > 500) return res.status(400).json({ error: 'Search query too long' });

    const term = `%${query}%`;
    const sessions = db.prepare(`
      SELECT DISTINCT s.* FROM sessions s
      LEFT JOIN issues i ON s.id = i.session_id
      WHERE s.deleted_at IS NULL AND (
           s.customer_name LIKE ? OR s.org_name LIKE ? OR s.account_number LIKE ? OR s.customer_email LIKE ?
        OR s.notes LIKE ? OR s.date_created LIKE ? OR i.description LIKE ? OR i.tags LIKE ? OR i.order_number LIKE ?)
      ORDER BY s.date_created DESC
    `).all(term, term, term, term, term, term, term, term, term);

    res.json(sessions.map(hydrate));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Organization and contact lookup (CSV) ────────────────────────────────────
// Two flat files back the typeahead fields. The seed writes them; every session
// save appends organizations and contacts it has not seen before, so the lists
// grow with use. Conflicts (same account number, different name) are reported
// back to the agent as warnings instead of silently rewriting the file.

const orgsCsvPath  = resolveData(process.env.ORGS_CSV_PATH, 'orgs.csv');
const usersCsvPath = resolveData(process.env.USERS_CSV_PATH, 'users.csv');
const ORGS_HEADER  = 'Organization Name,Account Number,CRM Org ID';
const USERS_HEADER = 'Account Number,Organization Name,Customer Name,Customer Email';

// Parse one CSV line, honoring quoted fields and "" escapes.
function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

function parseCsvRows(content) {
  return content.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(1).map(parseCsvLine);
}

function parseOrgsCsv(content) {
  return parseCsvRows(content)
    .map(f => ({ name: f[0]?.trim() || '', account_number: f[1]?.trim() || '', crm_org_id: f[2]?.trim() || '' }))
    .filter(o => o.name);
}

function parseUsersCsv(content) {
  return parseCsvRows(content)
    .map(f => ({ account_number: f[0]?.trim() || '', org_name: f[1]?.trim() || '', customer_name: f[2]?.trim() || '', customer_email: f[3]?.trim() || '' }))
    .filter(u => u.customer_name);
}

function csvField(v) {
  const s = (v || '').toString().trim();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/orgs', (req, res) => {
  try {
    if (!fs.existsSync(orgsCsvPath)) return res.json([]);
    res.json(parseOrgsCsv(fs.readFileSync(orgsCsvPath, 'utf8')));
  } catch (e) {
    console.error('Failed to load orgs CSV:', e.message);
    res.json([]);
  }
});

app.get('/api/users', (req, res) => {
  try {
    if (!fs.existsSync(usersCsvPath)) return res.json([]);
    res.json(parseUsersCsv(fs.readFileSync(usersCsvPath, 'utf8')));
  } catch (e) {
    console.error('Failed to load users CSV:', e.message);
    res.json([]);
  }
});

function syncLookups({ customer_name, org_name, account_number, crm_org_id, customer_email }) {
  const warnings = [];

  try {
    const acct = (account_number || '').trim();
    const orgName = (org_name || '').trim();
    if (acct && orgName) {
      const orgContent = fs.existsSync(orgsCsvPath) ? fs.readFileSync(orgsCsvPath, 'utf8') : ORGS_HEADER + '\n';
      const orgs = parseOrgsCsv(orgContent);
      const existing = orgs.find(o => o.account_number === acct);
      const newCrmId = (crm_org_id || '').trim();

      if (!existing) {
        const row = [csvField(orgName), csvField(acct), csvField(newCrmId)].join(',');
        fs.writeFileSync(orgsCsvPath, orgContent.replace(/\n+$/, '') + '\n' + row + '\n', 'utf8');
      } else {
        const existingCrmId = (existing.crm_org_id || '').trim();
        if (existing.name.toLowerCase() !== orgName.toLowerCase()) {
          warnings.push(`Lookup conflict: account # ${acct} is already saved as "${existing.name}", not "${orgName}". Ask an admin to fix the organization list if needed.`);
        } else if (newCrmId && !existingCrmId) {
          const rows = orgs.map(o => [csvField(o.name), csvField(o.account_number), csvField(o.account_number === acct ? newCrmId : o.crm_org_id)].join(','));
          fs.writeFileSync(orgsCsvPath, [ORGS_HEADER, ...rows].join('\n') + '\n', 'utf8');
        } else if (newCrmId && existingCrmId && newCrmId !== existingCrmId) {
          warnings.push(`Lookup conflict: "${existing.name}" already has CRM Org ID "${existingCrmId}", not "${newCrmId}". Ask an admin to fix the organization list if needed.`);
        }
      }
    }
  } catch (e) {
    console.error('Failed to sync orgs CSV:', e.message);
  }

  try {
    const name = (customer_name || '').trim();
    const email = (customer_email || '').trim();
    const org = (org_name || '').trim();
    const acct = (account_number || '').trim();
    if (name && email) {
      const usersContent = fs.existsSync(usersCsvPath) ? fs.readFileSync(usersCsvPath, 'utf8') : USERS_HEADER + '\n';
      const users = parseUsersCsv(usersContent);
      const nameLc = name.toLowerCase();
      const emailLc = email.toLowerCase();

      const sameEmailDiffName = users.find(u => u.customer_email.toLowerCase() === emailLc && u.customer_name.toLowerCase() !== nameLc);
      const sameNameDiffEmail = users.find(u => u.customer_name.toLowerCase() === nameLc && u.customer_email.toLowerCase() !== emailLc);
      if (sameEmailDiffName) {
        warnings.push(`Lookup conflict: ${email} is already saved under "${sameEmailDiffName.customer_name}". Ask an admin to fix the contact list if needed.`);
      } else if (sameNameDiffEmail) {
        warnings.push(`Lookup conflict: "${name}" is already saved with email ${sameNameDiffEmail.customer_email}. Ask an admin to fix the contact list if needed.`);
      } else {
        const exists = users.some(u => u.customer_name.toLowerCase() === nameLc && u.customer_email.toLowerCase() === emailLc && u.org_name.toLowerCase() === org.toLowerCase());
        if (!exists) {
          const row = [csvField(acct), csvField(org), csvField(name), csvField(email)].join(',');
          fs.writeFileSync(usersCsvPath, usersContent.replace(/\n+$/, '') + '\n' + row + '\n', 'utf8');
        }
      }
    }
  } catch (e) {
    console.error('Failed to sync users CSV:', e.message);
  }

  return warnings;
}

// ── Platforms ────────────────────────────────────────────────────────────────

app.get('/api/platforms', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM platforms ORDER BY id').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/platforms', writeLimiter, (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Platform name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'Platform name too long' });
    const result = db.prepare('INSERT INTO platforms (name, locked) VALUES (?, 0)').run(name.trim());
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Platform already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/platforms/:id', writeLimiter, (req, res) => {
  try {
    const platform = db.prepare('SELECT * FROM platforms WHERE id = ?').get(req.params.id);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    if (platform.locked) return res.status(400).json({ error: 'Cannot delete a default platform' });
    db.prepare('DELETE FROM platforms WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nightly backup (CSV export + .db copy) ───────────────────────────────────

const backupDir = resolveData(process.env.BACKUP_DIR, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

function backupCsvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function runBackup() {
  try {
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY date_created DESC').all();
    const headers = [
      'Session Date', 'Session ID', 'Note ID', 'Deleted', 'Customer Name', 'Org Name',
      'Account #', 'CRM Org ID', 'Customer Email', 'Session Notes',
      'Issue #', 'Issue Date', 'Platform', 'Helpdesk Ticket', 'Order #',
      'Tags', 'Status', 'Description', 'Resolution', 'Escalation Recipients'
    ];
    const rows = [headers.join(',')];

    sessions.forEach(session => {
      const issues = selectIssues.all(session.id);
      const base = [
        session.date_created, session.id, session.note_id || '', session.deleted_at ? 'Yes' : '',
        session.customer_name, session.org_name, session.account_number,
        session.crm_org_id || '', session.customer_email || '', session.notes || ''
      ];
      if (issues.length === 0) {
        rows.push([...base, '', '', '', '', '', '', '', '', '', ''].map(backupCsvEscape).join(','));
      } else {
        issues.forEach((issue, idx) => {
          rows.push([
            ...base,
            idx + 1, issue.date_created, issue.platform, issue.zendesk_ticket || '',
            issue.order_number || '', issue.tags || '', issue.status,
            issue.description, issue.resolution || '', issue.escalation_recipients || ''
          ].map(backupCsvEscape).join(','));
        });
      }
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(backupDir, `support-notes-backup-${dateStr}.csv`), rows.join('\n'), 'utf8');
    console.log(`Backup saved: support-notes-backup-${dateStr}.csv (${sessions.length} sessions)`);

    // WAL-safe online copy of the database file.
    db.backup(path.join(backupDir, `support-notes-backup-${dateStr}.db`))
      .then(() => console.log(`DB backup saved: support-notes-backup-${dateStr}.db`))
      .catch(e => console.error('DB backup failed:', e.message));

    // Keep seven days of backups; the helpdesk holds the long-term copy of every note.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(backupDir)
      .filter(f => f.startsWith('support-notes-backup-') && (f.endsWith('.csv') || f.endsWith('.db')))
      .forEach(f => {
        const fp = path.join(backupDir, f);
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); console.log(`Backup cleanup: removed ${f}`); }
      });
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

function scheduleDailyBackup() {
  const now = new Date();
  const next2am = new Date();
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  setTimeout(() => {
    runBackup();
    setInterval(runBackup, 24 * 60 * 60 * 1000).unref();
  }, next2am - now).unref();
  console.log(`Next backup scheduled at ${next2am.toLocaleString()}`);
}

app.get('/api/backup', (req, res) => {
  try { runBackup(); res.json({ success: true, backupDir }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helpdesk (Zendesk) ───────────────────────────────────────────────────────

app.post('/api/zendesk/create-ticket', writeLimiter, async (req, res) => {
  try {
    if (!zendeskEnabled()) return res.status(503).json({ error: 'Helpdesk integration is not configured on the server.' });

    const { session_id, issue_ids, subject } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    if (!Array.isArray(issue_ids) || issue_ids.length === 0) return res.status(400).json({ error: 'issue_ids must be a non-empty array' });
    if (!subject?.trim()) return res.status(400).json({ error: 'subject is required' });
    if (subject.length > 300) return res.status(400).json({ error: 'Subject too long (max 300 chars)' });

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const issues = issue_ids.map(id => db.prepare('SELECT * FROM issues WHERE id = ? AND session_id = ?').get(id, session_id)).filter(Boolean);
    if (issues.length === 0) return res.status(404).json({ error: 'No valid issues found' });

    const { ticket_id, ticket_url } = await createZendeskTicket(session, issues, subject.trim());

    const link = db.prepare('UPDATE issues SET zendesk_ticket = ? WHERE id = ?');
    db.transaction(() => issues.forEach(issue => link.run(ticket_id, issue.id)))();
    db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(session_id);

    res.json({ ticket_id, ticket_url });
    setImmediate(() => syncSession(session_id));
  } catch (e) {
    console.error('[zendesk] create-ticket error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Re-sync everything modified since the last checkpoint. ?force=true resets the checkpoint.
app.post('/api/zendesk-sync/run', writeLimiter, async (req, res) => {
  try {
    if (req.query.force === 'true') db.prepare('DELETE FROM kv_store WHERE key = ?').run('zendesk_reconcile_checkpoint');
    const result = await runReconciliation();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check linked tickets now instead of waiting for the scheduled poll.
app.post('/api/zendesk-sync/poll-tickets', writeLimiter, async (req, res) => {
  try { res.json({ success: true, ...(await pollTicketStatuses()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Sessions whose last sync failed, plus the tail of the error log.
app.get('/api/zendesk-sync/status', (req, res) => {
  try {
    const errorSessions = db.prepare(`
      SELECT id, note_id, customer_name, org_name, last_zendesk_sync_at, last_zendesk_sync_error
      FROM sessions
      WHERE last_zendesk_sync_error IS NOT NULL AND deleted_at IS NULL
      ORDER BY last_zendesk_sync_at DESC
    `).all();
    const pending = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE deleted_at IS NULL AND last_zendesk_sync_at IS NULL').get().c;

    let logTail = [];
    try { logTail = fs.readFileSync(ALERT_LOG, 'utf8').split('\n').filter(Boolean).slice(-50); } catch { /* no log yet */ }

    res.json({ enabled: zendeskEnabled(), mock: integrations.isMock, pending_sessions: pending, error_sessions: errorSessions, log_tail: logTail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mock only: what the in-memory helpdesk currently holds. Useful for demos and tests.
app.get('/api/helpdesk/records', (req, res) => {
  if (!integrations.isMock || typeof zendesk.listNoteRecords !== 'function') return res.status(404).json({ error: 'Only available with mock integrations' });
  res.json({ records: zendesk.listNoteRecords(), tickets: zendesk.listTickets() });
});

// ── Static UI (production build) ─────────────────────────────────────────────

const buildPath = path.join(ROOT, 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(buildPath, 'index.html')));
}

// ── Startup housekeeping ─────────────────────────────────────────────────────

// Purge recycle-bin entries older than 10 days, including their screenshot files.
const stale = db.prepare("SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-10 days')").all();
if (stale.length > 0) {
  const ids = stale.map(s => s.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`SELECT screenshots FROM issues WHERE session_id IN (${placeholders})`).all(...ids).forEach(i => removeScreenshotFiles(i.screenshots));
  const purged = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  console.log(`Recycle bin: purged ${purged.changes} session(s) older than 10 days`);
}

if (process.env.NODE_ENV !== 'test') {
  scheduleDailyBackup();
  scheduleReconciliation();
  scheduleTicketPoll();
  app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT} (helpdesk adapter: ${integrations.isMock ? 'mock' : 'real'})`);
  });
}

module.exports = app;
