#!/usr/bin/env node
// Rebuild the SQLite database and lookup files from scratch with deterministic sample data.
//
//   npm run seed
//
// Deletes the existing database, recreates the schema (src/database.js), writes the
// organization and contact lookup CSVs, and inserts fictional support sessions with
// issues, comments and helpdesk sync state. Every person, organization and note here
// is invented. Dates are relative to "now" so the history always looks current; a
// fixed PRNG seed keeps the output identical for a given day.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const resolveData = (envValue, fallback) => path.resolve(ROOT, envValue || path.join('data', fallback));
const DB_PATH = resolveData(process.env.DB_PATH, 'app.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* not there */ }
}

const db = require('../src/database');
const helpdesk = require('../src/integrations/fixtures/zendesk.json');

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
let state = 20260902;
function rand() {
  state |= 0; state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = arr => arr[Math.floor(rand() * arr.length)];
const hex = n => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

// ── Time helpers ────────────────────────────────────────────────────────────
const now = new Date();
function at(daysAgo, hour = 10, minute = 0) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}
const sql = d => d.toISOString().slice(0, 19).replace('T', ' ');
const plusMinutes = (s, m) => sql(new Date(new Date(s.replace(' ', 'T') + 'Z').getTime() + m * 60000));

// ═══════════════════════════════════════════════════════════════════════════
// Lookup files: organizations and contacts come from the helpdesk fixture so
// the directory, the mock helpdesk and the seeded notes all agree.
// ═══════════════════════════════════════════════════════════════════════════
const csv = v => /[",\n]/.test(v || '') ? `"${String(v).replace(/"/g, '""')}"` : (v || '');
const orgs = helpdesk.organizations;
const users = helpdesk.users.map(u => ({ ...u, org: orgs.find(o => o.account_number === u.account_number) }));

const ORGS_CSV = resolveData(process.env.ORGS_CSV_PATH, 'orgs.csv');
const USERS_CSV = resolveData(process.env.USERS_CSV_PATH, 'users.csv');
fs.mkdirSync(path.dirname(ORGS_CSV), { recursive: true });
fs.writeFileSync(ORGS_CSV, ['Organization Name,Account Number,CRM Org ID',
  ...orgs.map(o => [csv(o.name), csv(o.account_number), csv(o.crm_org_id)].join(','))].join('\n') + '\n');
fs.writeFileSync(USERS_CSV, ['Account Number,Organization Name,Customer Name,Customer Email',
  ...users.map(u => [csv(u.account_number), csv(u.org.name), csv(u.name), csv(u.email)].join(','))].join('\n') + '\n');

// ═══════════════════════════════════════════════════════════════════════════
// Issue scenarios: generic SaaS support, written the way an agent types during a call.
// ═══════════════════════════════════════════════════════════════════════════
const P = { web: 'Web App', admin: 'Admin Console', mobile: 'Mobile App', api: 'Public API', other: 'Other' };

const SCENARIOS = [
  { platform: P.web, tags: 'login,password', status: 'Solved',
    description: 'Could not log in after resetting password. Reset email had landed in spam. Marked the sender safe, set a new password together, login worked on the second try.',
    resolution: 'Password reset completed on the call.' },
  { platform: P.admin, tags: 'mfa,security', status: 'Solved',
    description: 'Lost the phone with the authenticator app. Verified identity with the account owner who was also on the call. Cleared MFA enrollment from Admin Console > Users; customer re-enrolled on the new device.',
    resolution: 'MFA reset and re-enrolled.' },
  { platform: P.admin, tags: 'permissions,users', status: 'Solved',
    description: 'Wants two new team members with read-only access to reports only. Walked through Roles, created a Viewer role scoped to Reports, invited both users.',
    resolution: 'Custom Viewer role created; invitations sent.' },
  { platform: P.web, tags: 'billing,refund', status: 'Escalated', order_number: 'INV-30417,INV-30418', escalation: 'billing@example.com',
    description: 'Charged twice for the annual plan renewal on the 3rd. Confirmed two invoices covering the same period in Billing > History. Customer wants the duplicate refunded to the original card.',
    resolution: '' },
  { platform: P.admin, tags: 'billing,invoice', status: 'Solved', order_number: 'INV-29980',
    description: 'Invoice PDF still shows the old billing address after they updated the company profile last month. Profile is correct; the invoice keeps the address from when it was generated. Regenerated the invoice from Admin Console and re-sent it.',
    resolution: 'Invoice regenerated with the current address.' },
  { platform: P.web, tags: 'reports,export,timezone', status: 'Solved',
    description: 'Monthly activity export is missing rows from the last two days of the month. Account time zone was set to UTC while the customer works in Central time, so the cutoff landed early. Changed the account time zone and re-ran the export; row count matched theirs.',
    resolution: 'Account time zone corrected; export verified.' },
  { platform: P.api, tags: 'webhooks,integration', status: 'Pending',
    description: 'Webhook deliveries to their endpoint have failed with 401 since Tuesday. Their team rotated the shared secret on the receiving side but the app still has the old one. They need to paste the new secret under Integrations > Webhooks. Developer was not on the call; they will confirm once updated.',
    resolution: '' },
  { platform: P.api, tags: 'api,walkthrough', status: 'Solved',
    description: 'Asked how to create a scoped API key for a nightly reporting script. Walked through Integrations > API Keys, created a read-only key, explained the 600 requests per minute limit and where usage shows up.',
    resolution: 'Read-only key created; docs link sent.' },
  { platform: P.admin, tags: 'sso,login', status: 'Flagged for Review',
    description: 'SSO sign-in loops back to the identity provider without an error. Their IdP signing certificate expired last week. Sent steps for uploading the new certificate under Security > Single Sign-On. Their IT team has to export it first.',
    resolution: '' },
  { platform: P.mobile, tags: 'mobile,crash,upload', status: 'Solved',
    description: 'Mobile app closes when attaching a photo larger than about 20 MB. Known issue in 4.2.1, fixed in 4.2.3. Customer updated from the app store during the call and the upload went through.',
    resolution: 'Updated to 4.2.3; upload confirmed.' },
  { platform: P.web, tags: 'import,csv', status: 'Pending',
    description: 'Bulk CSV import rejected with "unknown column" on row 1. Their spreadsheet export adds a trailing empty column. Showed how to delete it; the file they had on hand was already open elsewhere so they will re-export and try again tomorrow.',
    resolution: '' },
  { platform: P.web, tags: 'login,lockout', status: 'Solved',
    description: 'Account locked after five failed attempts right after a password change. Browser autofill kept submitting the old password. Unlocked the account from Admin Console and cleared the saved password together.',
    resolution: 'Account unlocked; stale saved password removed.' },
  { platform: P.web, tags: 'onboarding,walkthrough', status: 'Solved',
    description: 'New office manager taking over the account. 40 minute walkthrough: dashboard, creating a project, assigning tasks to team members, the weekly summary email, and where to find invoices. Sent the getting-started guide afterwards.',
    resolution: 'Walkthrough complete; guide emailed.' },
  { platform: P.web, tags: 'notifications,email', status: 'Solved',
    description: 'Not receiving the daily summary email. Notification preferences on their user had the summary switched off. Turned it on and sent a test message which arrived while we were on the call.',
    resolution: 'Daily summary re-enabled.' },
  { platform: P.admin, tags: 'custom-fields,forms', status: 'Solved',
    description: 'Wants a required Department dropdown on the intake form. Created the custom field in Admin Console > Forms with their six departments, marked it required, tested on a new record.',
    resolution: 'Custom field added and verified.' },
  { platform: P.web, tags: 'data,recovery', status: 'Solved',
    description: 'Asked whether deleted records can be recovered. Explained the 30 day recycle bin and restored the two records their intern deleted last week.',
    resolution: 'Two records restored.' },
  { platform: P.web, tags: 'performance', status: 'Escalated', escalation: 'engineering-oncall@example.com',
    description: 'Dashboard takes 20 to 30 seconds to load. Account has about 20,000 records. Reproduced while screen sharing; the summary widget request is the slow one. Captured timings from the browser network panel and escalated with the account id.',
    resolution: '' },
  { platform: P.web, tags: 'browser', status: 'Solved',
    description: 'Buttons on the Settings page do nothing. Browser is two major versions old and a privacy extension blocks scripts on our domain. Worked in a private window. Suggested updating the browser or allow-listing the site in the extension.',
    resolution: 'Confirmed working in a private window; customer will update the browser.' },
  { platform: P.web, tags: 'billing,plan', status: 'Pending',
    description: 'Wants to move from monthly to annual billing. Explained proration and the 15 percent annual discount, showed Billing > Plan > Change Plan. They will decide after talking to the owner.',
    resolution: '' },
  { platform: P.web, tags: 'reports,export', status: 'Solved',
    description: 'Needs the transactions export in a layout their accounting software accepts. Went through the export options and column mapping, saved the mapping as a preset so they do not have to redo it monthly.',
    resolution: 'Export preset saved.' },
  { platform: P.admin, tags: 'accounts,merge', status: 'Flagged for Review',
    description: 'Has two accounts under different email addresses and wants them merged. Merge requires written approval from the owner of each account. Sent the merge request form and explained which data carries over.',
    resolution: '' },
  { platform: P.web, tags: 'timezone,reminders', status: 'Solved',
    description: 'Scheduled reminders arrive three hours early. User profile time zone was still on the default. Fixed the profile and confirmed the next reminder time on the schedule page.',
    resolution: 'Profile time zone corrected.' },
  { platform: P.admin, tags: 'security,password-policy', status: 'Solved',
    description: 'Admin wants to enforce 12 character minimum passwords and 90 day rotation for everyone. Showed Security > Password Policy, enabled both, explained that existing users are prompted at their next login.',
    resolution: 'Password policy enabled.' },
  { platform: P.admin, tags: 'email,domain', status: 'Solved',
    description: 'Cannot verify their email domain for branded notifications. The TXT record was added to a subdomain instead of the root. Walked through the correct record with their DNS provider open on screen share; verification passed after a few minutes.',
    resolution: 'Domain verified.' },
  { platform: P.admin, tags: 'audit-log', status: 'Solved',
    description: 'Needs to know who deleted a record last Friday afternoon. Pulled the entry from Admin Console > Audit Log, exported the day to CSV for them.',
    resolution: 'Audit log entry located and exported.' },
  { platform: P.mobile, tags: 'mobile,session', status: 'Solved',
    description: 'Mobile app says the session expired every morning. Their device management policy clears app data overnight, which removes the login token. Nothing to change on our side; explained the cause so they can raise it with their IT team.',
    resolution: 'Cause identified: device policy clears app data nightly.' },
  { platform: P.api, tags: 'api,rate-limit', status: 'Solved',
    description: 'Nightly sync script hits rate limits about halfway through. Script requests one record at a time. Suggested the list endpoint with 200 per page and exponential backoff on 429; shared the pagination docs.',
    resolution: 'Pagination and backoff guidance provided.' },
  { platform: P.mobile, tags: 'feature-request', status: 'Flagged for Review',
    description: 'Asked for a dark mode in the mobile app. Not available yet. Logged as a feature request with the customer attached so they are notified if it ships.',
    resolution: '' },
  { platform: P.web, tags: 'billing,cancellation', status: 'Solved',
    description: 'Cancelled the plan mid cycle and asked about a partial refund. Cancellations are not prorated but access continues to the end of the paid period. Explained the policy and confirmed their end date.',
    resolution: 'Policy explained; access continues to period end.' },
  { platform: P.other, tags: 'training', status: 'Solved',
    description: 'Team of five joined for a refresher on the reporting module. Covered saved filters, scheduled reports and sharing a report link with people outside the account.',
    resolution: 'Training session delivered.' },
];

const SESSION_NOTES = [
  'Customer joined five minutes late. Screen shared throughout.',
  'Second call with this customer this month.',
  'Very patient, took notes on their side. Follow up not needed unless they email.',
  'Owner joined halfway through to approve the change.',
  'Poor audio for the first few minutes; switched to phone.',
  'Customer is migrating from another vendor; expect more questions next week.',
  '',
  '',
  '',
];

const COMMENTS = [
  ['Development Team', 'Reproduced on staging. Fix scheduled for the next release.'],
  ['Accounts Team', 'Refund of the duplicate invoice issued today.'],
  ['Support Team', 'Customer confirmed by email this is resolved.'],
  ['Support Team', 'Left a voicemail to follow up.'],
  ['Development Team', 'Needs the account id and a HAR file before we can look further.'],
];

// Sessions tied to fixture tickets. The ticket's requester is the customer on the call.
// Statuses line up: a solved or closed ticket means the issue is already Solved here.
const TICKETED = [
  { ticket: 41001, scenario: 11, daysAgo: 88 },
  { ticket: 41002, scenario: 5,  daysAgo: 74 },
  { ticket: 41003, scenario: 4,  daysAgo: 52 },
  { ticket: 41004, scenario: 6,  daysAgo: 19 },
  { ticket: 41005, scenario: 3,  daysAgo: 11 },
  { ticket: 41006, scenario: 8,  daysAgo: 6 },
  { ticket: 41007, scenario: 9,  daysAgo: 33 },
  { ticket: 41008, scenario: 10, daysAgo: 2 },
];

// ═══════════════════════════════════════════════════════════════════════════
// Insert
// ═══════════════════════════════════════════════════════════════════════════
const insSession = db.prepare(`
  INSERT INTO sessions (note_id, customer_name, org_name, account_number, crm_org_id, customer_email, notes,
                        date_created, updated_at, deleted_at, last_zendesk_sync_at, last_zendesk_sync_error)
  VALUES (@note_id, @customer_name, @org_name, @account_number, @crm_org_id, @customer_email, @notes,
          @date_created, @updated_at, @deleted_at, @last_sync, @sync_error)`);
const insIssue = db.prepare(`
  INSERT INTO issues (session_id, platform, tags, description, status, resolution, order_number, screenshots, escalation_recipients, zendesk_ticket, date_created)
  VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`);
const insComment = db.prepare('INSERT INTO comments (issue_id, author, body, date_created) VALUES (?, ?, ?, ?)');

let sessionCount = 0, issueCount = 0, commentCount = 0;

function addSession({ user, daysAgo, scenarios, ticket = null, deleted = false, syncState = 'auto' }) {
  const created = sql(at(daysAgo, between(13, 21), pick([0, 15, 30, 45]))); // 9am to 5pm US Eastern, in UTC
  const durationMin = between(20, 55);
  const updated = plusMinutes(created, durationMin);

  // Sync bookkeeping: older sessions have long since synced; a few recent ones are still pending
  // and one failed, so every badge state shows up in the history view.
  let lastSync = plusMinutes(updated, between(0, 2));
  let syncError = null;
  if (syncState === 'pending' || (syncState === 'auto' && daysAgo <= 1 && rand() < 0.6)) lastSync = null;
  if (syncState === 'error') syncError = 'Update failed (503): helpdesk temporarily unavailable';

  const s = insSession.run({
    note_id: uuid(),
    customer_name: user.name,
    org_name: user.org.name,
    account_number: user.account_number,
    crm_org_id: user.org.crm_org_id || null,
    customer_email: user.email,
    notes: pick(SESSION_NOTES) || null,
    date_created: created,
    updated_at: updated,
    deleted_at: deleted ? plusMinutes(updated, 60 * 24) : null,
    last_sync: lastSync,
    sync_error: syncError,
  });
  const sessionId = Number(s.lastInsertRowid);
  sessionCount++;

  scenarios.forEach((sc, idx) => {
    const issueCreated = plusMinutes(created, 3 + idx * Math.floor(durationMin / (scenarios.length + 1)));
    const r = insIssue.run(sessionId, sc.platform, sc.tags, sc.description, sc.status, sc.resolution || null,
      sc.order_number || null, sc.escalation || null, idx === 0 && ticket ? String(ticket) : null, issueCreated);
    issueCount++;
    if (sc.status === 'Escalated' || (sc.status === 'Solved' && rand() < 0.15) || (ticket && rand() < 0.5)) {
      const [author, body] = pick(COMMENTS);
      insComment.run(Number(r.lastInsertRowid), author, body, plusMinutes(updated, between(60, 60 * 30)));
      commentCount++;
    }
  });
}

const userByEmail = Object.fromEntries(users.map(u => [u.email, u]));
const ticketedScenarioIdx = new Set(TICKETED.map(t => t.scenario));

db.transaction(() => {
  // Sessions that produced helpdesk tickets.
  for (const t of TICKETED) {
    const ticket = helpdesk.tickets.find(x => x.id === t.ticket);
    addSession({ user: userByEmail[ticket.requester_email], daysAgo: t.daysAgo, scenarios: [SCENARIOS[t.scenario]], ticket: t.ticket });
  }

  // Everyday sessions spread over the last four months; every organization shows up more than once.
  const everyday = SCENARIOS.map((sc, i) => i).filter(i => !ticketedScenarioIdx.has(i));
  let cursor = 0;
  for (let i = 0; i < 34; i++) {
    const user = users[(i * 7 + between(0, 2)) % users.length];
    const daysAgo = i < 6 ? between(0, 3) : between(4, 118);
    const primary = SCENARIOS[everyday[cursor++ % everyday.length]];
    const scenarios = rand() < 0.3 ? [primary, SCENARIOS[everyday[cursor++ % everyday.length]]] : [primary];
    addSession({ user, daysAgo, scenarios });
  }

  // One recent session whose sync failed, one from today still pending, one in the recycle bin.
  addSession({ user: userByEmail['molly.quan@example.com'], daysAgo: 1, scenarios: [SCENARIOS[13]], syncState: 'error' });
  addSession({ user: userByEmail['devon.achebe@example.com'], daysAgo: 0, scenarios: [SCENARIOS[2]], syncState: 'pending' });
  addSession({ user: userByEmail['june.takeda@example.com'], daysAgo: 5, scenarios: [SCENARIOS[29]], deleted: true });
})();

console.log(`Seeded ${sessionCount} sessions, ${issueCount} issues, ${commentCount} comments`);
console.log(`Lookup files: ${orgs.length} organizations -> ${path.relative(ROOT, ORGS_CSV)}, ${users.length} contacts -> ${path.relative(ROOT, USERS_CSV)}`);
console.log(`Database: ${path.relative(ROOT, DB_PATH)}`);
