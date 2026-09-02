import { useRef, useEffect } from 'react';
import { API } from './constants';

export const parseDate = (str) => new Date(str.replace(' ', 'T') + 'Z');

const padDatePart = n => String(n).padStart(2, '0');

// Format a Date as a local YYYY-MM-DD (the value an <input type="date"> expects).
const toLocalYmd = (d) => `${d.getFullYear()}-${padDatePart(d.getMonth() + 1)}-${padDatePart(d.getDate())}`;

// A stored date_created string → local YYYY-MM-DD, so a date input pre-fills to
// the same day the card shows via toLocaleDateString().
export const toDateInputValue = (str) => toLocalYmd(parseDate(str));

// Today as a local YYYY-MM-DD — used as the new-note default and each input's max.
export const todayInputValue = () => toLocalYmd(new Date());

export const autoResize = el => {
  if (!el) return;
  const maxH = 15 * 21;
  el.style.height = 'auto';
  if (el.scrollHeight > maxH) {
    el.style.height = maxH + 'px';
    el.style.overflowY = 'auto';
  } else {
    el.style.height = el.scrollHeight + 'px';
    el.style.overflowY = 'hidden';
  }
};

export const screenshotUrl = (path) =>
  `${API}/screenshots/${path.split(/[\\/]/).pop()}`;

// Build the multipart body for POST/PUT /api/issues.
// Skips server-attached fields (`screenshots`, `comments`); kept screenshot
// paths go in `existing_screenshots`, new uploads in `files`.
export function buildIssueFormData(fields, { sessionId, existingScreenshots, files = [] } = {}) {
  const fd = new FormData();
  if (sessionId != null) fd.append('session_id', sessionId);
  Object.entries(fields).forEach(([k, v]) => {
    if (k !== 'screenshots' && k !== 'comments') fd.append(k, v || '');
  });
  if (existingScreenshots != null) fd.append('existing_screenshots', existingScreenshots);
  files.forEach(f => fd.append('screenshots', f));
  return fd;
}

export function useEscape(callback, enabled = true) {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const handler = e => { if (e.key === 'Escape') ref.current(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}

// Ctrl+S / Cmd+S → run callback (used to save the form in focus). The browser's
// "save page" dialog is suppressed while enabled.
export function useCtrlS(callback, enabled = true) {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const handler = e => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        ref.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled]);
}
