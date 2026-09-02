#!/usr/bin/env node
// Capture the README screenshots from a running instance using a headless browser.
//
//   npm run build && npm run seed && npm run server     (terminal 1: the API also serves build/)
//   npm run screenshots                                 (terminal 2)
//
// Uses playwright-core with a browser already on the machine (Chrome or Edge), so no
// browser download is needed. Set APP_URL to point at a different origin (for example
// the CRA dev server on http://localhost:3000). Output goes to docs/screenshots/.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

async function launch() {
  let lastErr;
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ headless: true, ...opts }); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await launch();
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', timezoneId: 'America/New_York', locale: 'en-US' });
  // Pre-set the per-browser preferences the app keeps in localStorage.
  await context.addInitScript(() => {
    localStorage.setItem('snDisplayName', 'Support Team');
    localStorage.setItem('snViewMode', 'list');
    localStorage.setItem('theme', 'light');
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));

  const save = async (file) => {
    const out = path.join(OUT_DIR, file);
    await page.screenshot({ path: out, fullPage: false });
    console.log('saved', path.relative(process.cwd(), out));
  };

  // 1. Session history: every session for one organization, one expanded with its sync status.
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.list-row', { timeout: 15000 });
  await page.fill('.search-bar input', 'Harborlight Dental Group');
  await page.click('.search-bar button:has-text("Search")');
  await page.waitForSelector('.search-indicator', { timeout: 15000 });
  await page.locator('.list-row').first().click();
  await page.waitForSelector('.list-row-expanded .session-card', { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0)); // keep the header and search query in frame
  await page.waitForTimeout(500);
  await save('session-history.png');

  // 2. Organization and contact lookup: the typeahead on the new-note form.
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.list-row', { timeout: 15000 });
  await page.click('.new-session-btn');
  await page.waitForSelector('.session-form', { timeout: 15000 });
  const orgInput = page.locator('.session-form .org-lookup input').nth(1); // second lookup is the organization
  await orgInput.fill('Ma');
  await page.waitForSelector('.org-dropdown li', { timeout: 15000 });
  await page.waitForTimeout(300);
  await save('lookup.png');

  // 3. Notes editor mid-session: contact picked from the directory, one issue typed up.
  await orgInput.fill('');
  const nameInput = page.locator('.session-form .org-lookup input').nth(0);
  await nameInput.fill('Aisha');
  await page.waitForSelector('.org-dropdown li', { timeout: 15000 });
  await page.locator('.org-dropdown li').first().click();
  await page.selectOption('.session-form select', { label: 'Admin Console' });
  await page.fill('.session-form .description-field',
    'Wants to add two new team members with read-only access to reports only. Walked through Roles, created a Viewer role scoped to Reports, invited both users.');
  await page.click('.session-form .status-btn.resolved-btn');
  await page.fill('.session-form .field:not(.field-dimmed) textarea.auto-expand >> nth=1', 'Custom Viewer role created; invitations sent.');
  await page.fill('.session-form .field textarea.auto-expand >> nth=-1', 'Customer joined five minutes late. Screen shared throughout.');
  await page.waitForTimeout(300);
  // The form is taller than the viewport; capture the whole element.
  const editorOut = path.join(OUT_DIR, 'notes-editor.png');
  await page.locator('.session-form').screenshot({ path: editorOut });
  console.log('saved', path.relative(process.cwd(), editorOut));

  await browser.close();
  if (consoleErrors.length) {
    console.warn(`\n${consoleErrors.length} console error(s) while capturing:`);
    consoleErrors.forEach(e => console.warn('  -', e));
  } else {
    console.log('\nNo console errors.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
