// SQLite schema and reference data.
// The database file is created on first require. `npm run seed` rebuilds it with sample data.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || path.join('data', 'app.db'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // readers never block the writer
db.pragma('foreign_keys = ON');

db.exec(`
  -- One row per support session (one customer, one call). note_id is the stable
  -- key used as external_id in the helpdesk so re-syncs update instead of duplicate.
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    org_name TEXT NOT NULL,
    account_number TEXT NOT NULL DEFAULT '',
    crm_org_id TEXT,
    customer_email TEXT,
    notes TEXT,
    date_created TEXT NOT NULL,
    updated_at TEXT,
    deleted_at TEXT,                 -- soft delete (recycle bin)
    last_zendesk_sync_at TEXT,       -- last sync attempt
    last_zendesk_sync_error TEXT     -- NULL when the last attempt succeeded
  );

  -- Each session holds one or more issues discussed on the call.
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    tags TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Flagged for Review | Escalated | Solved
    resolution TEXT,
    order_number TEXT,               -- comma separated
    screenshots TEXT,                -- comma separated filenames under SCREENSHOT_DIR
    escalation_recipients TEXT,
    zendesk_ticket TEXT,             -- linked helpdesk ticket id
    date_created TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- Threaded comments on an issue, attributed to a team.
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    date_created TEXT NOT NULL,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );

  -- Product areas an issue can be filed under. Locked rows cannot be deleted from the UI.
  CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    locked INTEGER NOT NULL DEFAULT 0
  );

  -- Small key-value store for internal state (helpdesk reconciliation checkpoint).
  CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_date    ON sessions(date_created);
  CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_issues_session   ON issues(session_id);
  CREATE INDEX IF NOT EXISTS idx_comments_issue   ON comments(issue_id);
`);

// Default platforms. The UI lists them by id and defaults new issues to the first one.
const DEFAULT_PLATFORMS = [['Web App', 1], ['Admin Console', 1], ['Mobile App', 1], ['Public API', 0], ['Other', 0]];
if (db.prepare('SELECT COUNT(*) AS c FROM platforms').get().c === 0) {
  const insert = db.prepare('INSERT INTO platforms (name, locked) VALUES (?, ?)');
  db.transaction(() => DEFAULT_PLATFORMS.forEach(([name, locked]) => insert.run(name, locked)))();
}

console.log('Database initialized at:', DB_PATH);

module.exports = db;
