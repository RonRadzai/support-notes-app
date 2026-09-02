#!/usr/bin/env node
// Record the README demo GIF: a scripted 30 to 45 second walk through the seeded app.
//
//   npm run build && npm run seed && npm run server   (terminal 1)
//   npm run demo-gif                                  (terminal 2)
//
// Pure JavaScript, no ffmpeg: Playwright drives the browser and takes a screenshot at
// every pause point of the walkthrough; each frame is shown for as long as that pause
// lasted; identical consecutive frames are merged; gifenc encodes docs/demo.gif.
// The walkthrough saves a note, so re-seed before recording again.
// Set APP_URL to record against a different origin (default http://localhost:3001).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';
const OUT = path.join(__dirname, '..', 'docs', 'demo.gif');
const SIZE = { width: 1200, height: 750 };
const MAX_COLORS = 128;

async function launch() {
  let lastErr;
  for (const opts of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ headless: true, ...opts }); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Every pause captures the current screen as a frame, then holds it for `ms`.
const frames = [];
async function pause(page, ms) {
  frames.push({ t: Date.now(), png: await page.screenshot({ type: 'png' }) });
  await page.waitForTimeout(ms);
}

async function scroll(page, px, steps = 5) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await pause(page, 180); }
}

// Type a value in visible chunks so the GIF shows it being entered.
async function typeInto(locator, text, chunk = 4, ms = 220) {
  await locator.fill('');
  for (let i = 0; i < text.length; i += chunk) {
    await locator.fill(text.slice(0, i + chunk));
    await pause(locator.page(), ms);
  }
}

// ── The walkthrough (mirrors the click path described in the README) ────────
async function walkthrough(page) {
  // 1. Session history, then one organization's history
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.list-row');
  await pause(page, 2500);
  await typeInto(page.locator('.search-bar input'), 'Maple Ridge', 3, 200);
  await page.click('.search-bar button:has-text("Search")');
  await page.waitForSelector('.search-indicator');
  await pause(page, 2200);

  // 2. Expand a session: issues, statuses, resolutions
  await page.locator('.list-row').first().click();
  await page.waitForSelector('.list-row-expanded .session-card');
  await pause(page, 2800);
  await scroll(page, 320);
  await pause(page, 1800);

  // 3. New note: pick the contact from the directory
  await page.click('.search-bar button:has-text("Clear")');
  await page.waitForFunction(() => !document.querySelector('.search-indicator'), { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(page, 800);
  await page.click('.new-session-btn');
  await page.waitForSelector('.session-form');
  await pause(page, 1500);
  const nameInput = page.locator('.session-form .org-lookup input').nth(0);
  await typeInto(nameInput, 'Aisha', 2, 260);
  await page.waitForSelector('.org-dropdown li');
  await pause(page, 1400);
  await page.locator('.org-dropdown li').first().click();
  await pause(page, 2200);

  // 4. Log the issue and resolve it
  await page.selectOption('.session-form select', { label: 'Admin Console' });
  await pause(page, 900);
  await typeInto(page.locator('.session-form .description-field'),
    'Wants two new team members with read-only access to reports. Walked through Roles, created a Viewer role scoped to Reports, invited both users.', 14, 140);
  await pause(page, 900);
  await page.click('.session-form .status-btn.resolved-btn');
  await pause(page, 900);
  await typeInto(page.locator('.session-form .field:not(.field-dimmed) textarea.auto-expand').nth(1), 'Viewer role created; invitations sent.', 8, 160);
  await pause(page, 1500);

  // 5. Save: the note lands in today's group (it syncs to the helpdesk in the background)
  await page.click('.session-form .submit-btn:not(.submit-btn--zendesk)');
  await page.waitForSelector('.list-row:has-text("Aisha Rahman")');
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(page, 3000);

  // 6. Open the note and start a helpdesk ticket from it. Seeded sessions later today can
  // sort above the new note, so find its row by name rather than by position.
  await page.locator('.list-row:has-text("Aisha Rahman")').first().click();
  await page.waitForSelector('.list-row-expanded .session-card');
  await pause(page, 2000);
  await page.locator('.list-row-expanded .session-card .kebab-btn').first().click();
  await pause(page, 1300);
  await page.click('.kebab-item:has-text("Create Zendesk Ticket")');
  await page.waitForSelector('.zd-modal');
  await pause(page, 3200);
  frames.push({ t: Date.now(), png: await page.screenshot({ type: 'png' }) }); // closing frame
}

// ── Encode: merge identical frames, quantize each to a local palette ────────
function encodeGif(frames) {
  const merged = [];
  for (const f of frames) {
    const prev = merged[merged.length - 1];
    if (prev && prev.png.equals(f.png)) continue;   // still frame: the delay math below covers it
    merged.push(f);
  }
  const gif = GIFEncoder();
  merged.forEach((f, i) => {
    const next = merged[i + 1];
    const delay = next ? next.t - f.t : 2500;
    const { width, height, data } = PNG.sync.read(f.png);
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const palette = quantize(rgba, MAX_COLORS);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, { palette, delay });
  });
  gif.finish();
  return { bytes: gif.bytes(), uniqueFrames: merged.length, totalFrames: frames.length };
}

async function main() {
  const browser = await launch();
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'light', locale: 'en-US', timezoneId: 'America/New_York' });
  await context.addInitScript(() => {
    localStorage.setItem('snDisplayName', 'Support Team');
    localStorage.setItem('snViewMode', 'list');
    localStorage.setItem('theme', 'light');
  });
  const page = await context.newPage();

  const started = Date.now();
  await walkthrough(page);
  const seconds = Math.round((Date.now() - started) / 1000);
  await browser.close();

  console.log(`captured ${frames.length} frames over ${seconds}s, encoding…`);
  const { bytes, uniqueFrames } = encodeGif(frames);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log(`saved ${path.relative(process.cwd(), OUT)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${uniqueFrames} unique frames, ${seconds}s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
