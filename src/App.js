import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { API, emptySession, emptyIssue } from './constants';
import { parseDate, autoResize, screenshotUrl, buildIssueFormData, todayInputValue, useCtrlS } from './utils';
import { Lightbox } from './components/Lightbox';
import { IssueForm } from './components/IssueForm';
import { Toast } from './components/Toast';
import { WarningModal } from './components/WarningModal';
import { PlatformManager } from './components/PlatformManager';
import { OrgLookup } from './components/OrgLookup';
import { UserLookup } from './components/UserLookup';
import { RecycleBin } from './components/RecycleBin';
import { SessionCard } from './components/SessionCard';
import { ListRow } from './components/ListRow';
import { ZendeskModal } from './components/ZendeskModal';
import { ConfigContext, defaultConfig } from './config';

// Optional header link (for example the standing video call used for support sessions).
const MEETING_URL = process.env.REACT_APP_MEETING_URL;

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [session, setSession] = useState({ ...emptySession });
  const [sessionDate, setSessionDate] = useState(todayInputValue());
  const [issues, setIssues] = useState([{ ...emptyIssue }]);
  const [issuesScreenshots, setIssuesScreenshots] = useState([[]]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const [warningModal, setWarningModal] = useState([]);
  const [expandedListId, setExpandedListId] = useState(null);
  const [saving, setSaving] = useState(false);
  // 'save' or 'ticket' — which new-note submit button was pressed. A ref (not
  // state) so it's set synchronously in onClick before the form's onSubmit.
  const submitIntentRef = useRef('save');
  const [zdSession, setZdSession] = useState(null);
  // Warnings deferred until the ticket dialog closes, so they don't stack.
  const pendingWarningsRef = useRef(null);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('snDisplayName') || '');
  const [serverOffline, setServerOffline] = useState(false);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('snViewMode') || 'list');
  const [loading, setLoading] = useState(true);
  const [activeSearch, setActiveSearch] = useState('');
  const activeSearchRef = useRef('');
  const [page, setPage] = useState(1);
  const formRef = useRef(null);
  const newNoteFormRef = useRef(null);
  const [platforms, setPlatforms] = useState([]);
  const [showPlatformManager, setShowPlatformManager] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [lightbox, setLightbox] = useState(null);
  const [linkedSession, setLinkedSession] = useState(false);
  const [config, setConfig] = useState(defaultConfig);
  const viewScreenshot = (path) => setLightbox({ src: screenshotUrl(path), filename: path.split(/[\\/]/).pop() });
  const toggleDarkMode = () => setDarkMode(d => { const n = !d; localStorage.setItem('theme', n ? 'dark' : 'light'); return n; });
  useEffect(() => { document.body.classList.toggle('dark', darkMode); }, [darkMode]);

  const fetchJson = async (path, setter, label) => {
    try {
      const res = await fetch(`${API}${path}`);
      setter(await res.json());
    } catch (e) { console.error(`Failed to fetch ${label}`, e); }
  };
  const fetchPlatforms = () => fetchJson('/api/platforms', setPlatforms, 'platforms');
  const fetchOrgs = () => fetchJson('/api/orgs', setOrgs, 'orgs');
  const fetchUsers = () => fetchJson('/api/users', setUsers, 'users');

  const savePlatforms = async (newList) => {
    const toAdd = newList.filter(p => !p.id);
    const toRemove = platforms.filter(p => !newList.find(n => n.id === p.id));
    await Promise.all([
      ...toAdd.map(p => fetch(`${API}/api/platforms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name })
      })),
      ...toRemove.map(p => fetch(`${API}/api/platforms/${p.id}`, { method: 'DELETE' }))
    ]);
    fetchPlatforms();
  };

  const showToast = (message, type = 'success', href = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type, href });
    toastTimerRef.current = setTimeout(() => { setToast(null); toastTimerRef.current = null; }, 5000);
  };

  const filteredSessions = sessions.filter(s => {
    const created = parseDate(s.date_created);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (dateFilter === 'today') return created >= startOfToday;
    if (dateFilter === 'week') {
      const from = new Date(startOfToday);
      from.setDate(from.getDate() - 7);
      return created >= from;
    }
    if (dateFilter === 'month') {
      const from = new Date(startOfToday);
      from.setMonth(from.getMonth() - 1);
      return created >= from;
    }
    if (dateFilter === 'yesterday') {
      const startOfYesterday = new Date(startOfToday);
      startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      return created >= startOfYesterday && created < startOfToday;
    }
    if (dateFilter === 'custom') {
      const parseLocalDate = (str) => { const [y, m, d] = str.split('-').map(Number); return new Date(y, m - 1, d); };
      if (customFrom && created < parseLocalDate(customFrom)) return false;
      if (customTo) {
        const to = parseLocalDate(customTo);
        to.setHours(23, 59, 59, 999);
        if (created > to) return false;
      }
      return true;
    }
    return true;
  });

  const statusFilteredSessions = filteredSessions.filter(s => {
    if (statusFilter === 'all') return true;
    const iss = s.issues || [];
    if (statusFilter === 'active') return iss.length === 0 || iss.some(i => i.status === 'Pending');
    if (statusFilter === 'zendesk') return iss.some(i => i.zendesk_ticket);
    if (statusFilter === 'flagged') return iss.some(i => i.status === 'Flagged for Review');
    if (statusFilter === 'resolved') return iss.length > 0 && iss.every(i => i.status === 'Solved');
    return true;
  });

  const PAGE_SIZE = 100;
  const filterActive = statusFilter !== 'all' || dateFilter !== 'all' || activeSearch !== '';
  const showAll = filterActive && statusFilteredSessions.length <= 500;
  const totalPages = showAll ? 1 : Math.ceil(statusFilteredSessions.length / PAGE_SIZE) || 1;
  const pagedSessions = showAll ? statusFilteredSessions : statusFilteredSessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    const q = params.get('search');
    if (sessionId) {
      fetch(`${API}/api/sessions/${sessionId}`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(s => { setSessions([s]); setExpandedListId(s.id); setLinkedSession(true); setLoading(false); })
        .catch(() => { fetchSessions(); });
    } else {
      if (q) { setSearchTerm(q); setActiveSearch(q); activeSearchRef.current = q; }
      fetchSessions();
    }
    fetchPlatforms(); fetchOrgs(); fetchUsers();
    fetchJson('/api/config', c => setConfig({ ...defaultConfig, ...c }), 'config');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => fetchSessions(true), 30000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [statusFilter, dateFilter, activeSearch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { activeSearchRef.current = activeSearch; }, [activeSearch]);
  useEffect(() => { if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [showForm]);

  const fetchSessions = async (silent = false) => {
    try {
      const currentSearch = activeSearchRef.current;
      const url = currentSearch
        ? `${API}/api/search?query=${encodeURIComponent(currentSearch)}`
        : `${API}/api/sessions`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      setSessions(await res.json());
      setServerOffline(false);
    } catch (e) { console.error(e); if (!silent) setServerOffline(true); }
    finally { if (!silent) setLoading(false); }
  };

  const exportCSV = () => {
    const headers = [
      'Date', 'Note ID', 'Customer Name', 'Org Name', 'Account Number', 'CRM Org ID',
      'Customer Email', 'Session Notes', 'Platform', 'Status',
      'Order Number', 'Issue Description', 'Resolution', 'Escalated To', 'Screenshots'
    ];
    const esc = (val) => {
      if (val == null) return '';
      const s = String(val);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [];
    filteredSessions.forEach(s => {
      const date = parseDate(s.date_created).toLocaleDateString();
      const base = [date, s.note_id || '', s.customer_name, s.org_name, s.account_number || '',
        s.crm_org_id || '', s.customer_email || '', s.notes || ''];
      if (!s.issues || s.issues.length === 0) {
        rows.push([...base, '', '', '', '', '', '', '', '']);
      } else {
        s.issues.forEach(iss => {
          const shots = iss.screenshots ? iss.screenshots.split(',').filter(Boolean).length : 0;
          rows.push([...base,
            iss.platform, iss.status, iss.order_number || '',
            iss.description, iss.resolution || '', iss.escalation_recipients || '',
            shots > 0 ? `${shots} screenshot(s)` : ''
          ]);
        });
      }
    });
    const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `support-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSearch = async () => {
    if (!searchTerm.trim()) { setActiveSearch(''); return fetchSessions(); }
    try {
      const res = await fetch(`${API}/api/search?query=${encodeURIComponent(searchTerm)}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      setSessions(await res.json());
      setActiveSearch(searchTerm.trim());
    } catch (e) { console.error(e); showToast('Search failed. Please try again.', 'error'); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const createTicket = submitIntentRef.current === 'ticket';
    submitIntentRef.current = 'save';
    setSaving(true);
    try {
      // Only send a date when the user changed it away from today, so the
      // default path keeps the server's full-precision timestamp.
      const sessionBody = sessionDate && sessionDate !== todayInputValue()
        ? { ...session, date_created: sessionDate }
        : session;
      const sRes = await fetch(`${API}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionBody)
      });
      const sData = await sRes.json();
      if (!sRes.ok) throw new Error(sData.error || `Server error (${sRes.status})`);
      const session_id = sData.id;
      const warnings = sData.warnings || [];

      const createdIssueIds = [];
      for (let idx = 0; idx < issues.length; idx++) {
        const iss = issues[idx];
        if (!iss.description.trim()) continue;
        const issueToSend = { ...iss, platform: iss.platform || platforms[0]?.name || '', order_number: iss.order_number.split(',').filter(n => n.trim()).join(',') };
        const fd = buildIssueFormData(issueToSend, { sessionId: session_id, files: issuesScreenshots[idx] });
        const iRes = await fetch(`${API}/api/issues`, { method: 'POST', body: fd });
        const iData = await iRes.json().catch(() => ({}));
        if (!iRes.ok) throw new Error(iData.error || `Issue ${idx + 1} failed to save (${iRes.status})`);
        if (iData.id) createdIssueIds.push(iData.id);
      }

      setSession({ ...emptySession });
      setSessionDate(todayInputValue());
      setIssues([{ ...emptyIssue }]);
      setIssuesScreenshots([[]]);
      setShowForm(false);
      fetchSessions();
      window.scrollTo({ top: 0, behavior: 'smooth' });

      // If the user chose "Save & Create Zendesk Ticket" and the note has at
      // least one saved issue, re-fetch the hydrated session and open the
      // dialog on top. The note is already saved regardless of what follows.
      let ticketSession = null;
      if (createTicket && createdIssueIds.length > 0) {
        ticketSession = await fetch(`${API}/api/sessions/${session_id}`)
          .then(r => r.ok ? r.json() : null).catch(() => null);
      }

      if (ticketSession) {
        if (warnings.length) pendingWarningsRef.current = warnings; // shown after the dialog closes
        showToast('Note saved successfully');
        setZdSession(ticketSession);
      } else if (warnings.length) {
        setWarningModal(warnings);
      } else if (createTicket && createdIssueIds.length === 0) {
        showToast('Note saved. Add an issue before creating a Zendesk ticket.');
      } else if (createTicket) {
        showToast('Note saved. Open the ticket from the note\'s ⋮ menu.', 'error');
      } else {
        showToast('Note saved successfully');
      }
    } catch (e) {
      console.error(e);
      showToast(`Failed to save note: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Unsaved-changes protection for the new-note form ──────────
  const newNoteDirty = showForm && (
    JSON.stringify(session) !== JSON.stringify(emptySession) ||
    JSON.stringify(issues) !== JSON.stringify([emptyIssue]) ||
    issuesScreenshots.some(arr => arr.length > 0) ||
    sessionDate !== todayInputValue()
  );

  const resetForm = () => {
    setSession({ ...emptySession });
    setSessionDate(todayInputValue());
    setIssues([{ ...emptyIssue }]);
    setIssuesScreenshots([[]]);
    setShowForm(false);
  };

  const cancelForm = () => {
    if (newNoteDirty && !window.confirm('Discard unsaved changes?')) return;
    resetForm();
  };

  useEffect(() => {
    if (!newNoteDirty) return;
    const handler = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [newNoteDirty]);

  useCtrlS(() => newNoteFormRef.current?.requestSubmit(), showForm && !saving);

  const changeDisplayName = team => { localStorage.setItem('snDisplayName', team); setDisplayName(team); };
  const sessionRowProps = {
    onRefresh: fetchSessions, onViewScreenshot: viewScreenshot,
    showToast, showWarning: setWarningModal, platforms, orgs, users,
    displayName, onChangeName: changeDisplayName,
  };
  const dayGroups = Object.entries(
    pagedSessions.reduce((groups, s) => {
      const day = parseDate(s.date_created).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      (groups[day] = groups[day] || []).push(s);
      return groups;
    }, {})
  );
  const paginationBar = totalPages > 1 && (
    <div className="pagination-bar">
      <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
      <span className="page-indicator">Page {page} of {totalPages}</span>
      <button className="page-btn" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
    </div>
  );

  return (
    <ConfigContext.Provider value={config}>
    <div className={`App${darkMode ? ' dark' : ''}`}>
      <header className="App-header">
        <div className="header-title-row">
          <div>
            <h1>Support Session Notes</h1>
            <p className="header-subtitle">Support Team &middot; Session Log{config.mock_integrations ? ' · Demo data' : ''}</p>
          </div>
          <div className="header-title-right">
            <div className="theme-control">
              <span className="theme-label">Theme <span className="theme-icon">{darkMode ? '🌙' : '☀️'}</span></span>
              <label className="theme-toggle-switch">
                <input type="checkbox" checked={darkMode} onChange={toggleDarkMode} />
                <span className="theme-toggle-track"><span className="theme-toggle-thumb" /></span>
              </label>
            </div>
            {MEETING_URL && (
              <a className="meeting-btn" href={MEETING_URL} target="_blank" rel="noreferrer">
                Join support call
              </a>
            )}
          </div>
        </div>
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search by customer, org, account number, email, order number, notes, or date (e.g. 2026-02)..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch}>Search</button>
          <button onClick={() => { setSearchTerm(''); setActiveSearch(''); fetchSessions(); }}>Clear</button>
        </div>
        <div className="filter-bar">
          <div className="filter-group">
            <label className="filter-label">Date</label>
            <select className="filter-select" value={dateFilter} onChange={e => setDateFilter(e.target.value)}>
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
              <option value="custom">Custom range</option>
            </select>
            {dateFilter === 'custom' && (
              <div className="custom-date-range">
                <input type="date" className="date-input" value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)} />
                <span className="date-range-sep">to</span>
                <input type="date" className="date-input" value={customTo}
                  onChange={e => setCustomTo(e.target.value)} />
              </div>
            )}
          </div>
          <div className="filter-group">
            <label className="filter-label">Status</label>
            <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="flagged">Flagged for Review</option>
              <option value="zendesk">Notes with Zendesk Tickets</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          <button className="export-btn" onClick={exportCSV} disabled={filteredSessions.length === 0}>
            Export CSV
          </button>
          <div className="view-toggle">
            <button className={`view-btn${viewMode === 'list' ? ' active' : ''}`} title="List view" onClick={() => { setViewMode('list'); localStorage.setItem('snViewMode', 'list'); }}>&#9776;</button>
            <button className={`view-btn${viewMode === 'card' ? ' active' : ''}`} title="Card view" onClick={() => { setViewMode('card'); localStorage.setItem('snViewMode', 'card'); }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1.5" width="14" height="3.5" rx="1.2" fill="currentColor" />
                <rect x="1" y="6.25" width="14" height="3.5" rx="1.2" fill="currentColor" />
                <rect x="1" y="11" width="14" height="3.5" rx="1.2" fill="currentColor" />
              </svg>
            </button>
            <button className="view-btn" title="Recycle Bin" onClick={() => setShowRecycleBin(true)}>♻️</button>
          </div>
        </div>
      </header>

      <div className="new-note-bar">
        <button className="new-session-btn" onClick={() => {
          if (showForm) {
            cancelForm();
          } else {
            setSessionDate(todayInputValue());
            setShowForm(true);
          }
        }}>
          {showForm ? 'Cancel' : '+ New Note'}
        </button>
        {paginationBar}
      </div>

      {serverOffline && (
        <div className="offline-banner">
          Server is unreachable. Make sure the backend is running on port 3001, then refresh.
        </div>
      )}

      {showForm && (
        <div className={`session-form${viewMode === 'list' ? ' session-form--list' : ''}`} ref={formRef}>
          <h2>New Customer Note</h2>
          <form onSubmit={handleSubmit} ref={newNoteFormRef}>
            <div className="field field--date">
              <label>Note Date</label>
              <input type="date" max={todayInputValue()}
                value={sessionDate}
                onChange={e => setSessionDate(e.target.value)} />
            </div>
            <h3 className="section-label">Customer Info</h3>
            <div className="form-row">
              <div className="field">
                <label>Customer Name <span className="req">*</span></label>
                <UserLookup
                  required
                  value={session.customer_name}
                  users={users}
                  onType={v => setSession({ ...session, customer_name: v })}
                  onSelect={u => {
                    const org = orgs.find(o => o.account_number && o.account_number === u.account_number);
                    setSession({
                      ...session,
                      customer_name: u.customer_name,
                      customer_email: u.customer_email,
                      org_name: u.org_name || (org ? org.name : session.org_name),
                      account_number: u.account_number || session.account_number,
                      crm_org_id: org ? org.crm_org_id : session.crm_org_id,
                    });
                  }}
                />
              </div>
              <div className="field">
                <label>Customer Email</label>
                <input type="email" value={session.customer_email}
                  onChange={e => setSession({ ...session, customer_email: e.target.value })} />
              </div>
            </div>
            <div className="form-row-3">
              <div className="field">
                <label>Organization Name <span className="req">*</span></label>
                <OrgLookup
                  required
                  value={session.org_name}
                  orgs={orgs}
                  onType={v => setSession({ ...session, org_name: v })}
                  onSelect={org => setSession({ ...session, org_name: org.name, account_number: org.account_number, crm_org_id: org.crm_org_id })}
                />
              </div>
              <div className="field">
                <label>Account Number</label>
                <input type="text" value={session.account_number}
                  onChange={e => {
                    const v = e.target.value;
                    const match = v.trim() ? orgs.find(o => o.account_number === v.trim()) : null;
                    setSession(match ? { ...session, account_number: v, org_name: match.name, crm_org_id: match.crm_org_id } : { ...session, account_number: v });
                  }} />
              </div>
              <div className="field">
                <label>CRM Org ID</label>
                <input type="text" value={session.crm_org_id}
                  onChange={e => setSession({ ...session, crm_org_id: e.target.value })} />
              </div>
            </div>

            <h3 className="section-label" style={{ marginTop: '24px' }}>Issues</h3>
            {issues.map((iss, idx) => (
              <div key={idx} className={`issue-section${issues.length > 1 ? ' multi' : ''}`}>
                {issues.length > 1 && (
                  <div className="issue-section-header">
                    <span>Issue {idx + 1}</span>
                    <button type="button" className="remove-issue-btn"
                      onClick={() => {
                        setIssues(prev => prev.filter((_, i) => i !== idx));
                        setIssuesScreenshots(prev => prev.filter((_, i) => i !== idx));
                      }}>× Remove</button>
                  </div>
                )}
                <IssueForm
                  data={iss}
                  onChange={updated => setIssues(prev => prev.map((x, i) => i === idx ? updated : x))}
                  platforms={platforms}
                  screenshots={issuesScreenshots[idx]}
                  onScreenshotsChange={files => setIssuesScreenshots(prev => prev.map((s, i) => i === idx ? files : s))}
                  showPlatformCustomize={idx === 0}
                  onCustomizePlatforms={() => setShowPlatformManager(true)}
                />
              </div>
            ))}
            <button type="button" className="add-another-issue-btn"
              onClick={() => {
                setIssues(prev => [...prev, { ...emptyIssue }]);
                setIssuesScreenshots(prev => [...prev, []]);
              }}>
              + Add Another Issue
            </button>
            <div className="field" style={{ marginTop: '16px' }}>
              <label>Session Notes</label>
              <textarea className="auto-expand" value={session.notes}
                ref={el => autoResize(el)}
                onChange={e => setSession({ ...session, notes: e.target.value })}
                onInput={e => autoResize(e.target)} />
            </div>
            <div className="form-actions">
              <button type="submit" className="submit-btn" disabled={saving}
                onClick={() => { submitIntentRef.current = 'save'; }}>
                {saving ? 'Saving...' : 'Save Note'}
              </button>
              <button type="submit" className="submit-btn submit-btn--zendesk" disabled={saving}
                onClick={() => { submitIntentRef.current = 'ticket'; }}>
                <span className="zd-logo zd-logo--inverse" aria-hidden="true" />
                Save &amp; Create Zendesk Ticket
              </button>
              <button type="button" className="btn-cancel" onClick={cancelForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} href={toast.href} />}
      <WarningModal messages={warningModal} onClose={() => setWarningModal([])} />
      {lightbox && <Lightbox src={lightbox.src} filename={lightbox.filename} onClose={() => setLightbox(null)} />}

      {showPlatformManager && (
        <PlatformManager
          platforms={platforms}
          onSave={savePlatforms}
          onClose={() => setShowPlatformManager(false)}
        />
      )}

      {showRecycleBin && (
        <RecycleBin
          onClose={() => setShowRecycleBin(false)}
          onRestored={() => { setShowRecycleBin(false); fetchSessions(); showToast('Session restored'); }}
          showToast={showToast}
        />
      )}

      {zdSession && (
        <ZendeskModal
          session={zdSession}
          onClose={() => {
            setZdSession(null);
            if (pendingWarningsRef.current) { setWarningModal(pendingWarningsRef.current); pendingWarningsRef.current = null; }
          }}
          onCreated={fetchSessions}
          showToast={showToast}
        />
      )}

      {linkedSession && (
        <p className="search-indicator">
          Showing one linked session.{' '}
          <button
            style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
            onClick={() => { setLinkedSession(false); setExpandedListId(null); fetchSessions(); }}
          >
            View all sessions
          </button>
        </p>
      )}
      {activeSearch && (
        <p className="search-indicator">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''} found for "{activeSearch}"
        </p>
      )}

      <div className="sessions-list">
        {loading && sessions.length === 0 && (
          <div className="loading-state">
            <div className="loading-spinner"></div>
            <p>Loading notes...</p>
          </div>
        )}
        {!loading && statusFilteredSessions.length === 0 && !showForm && (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p>{sessions.length === 0
              ? activeSearch
                ? `No results found for "${activeSearch}".`
                : 'No notes yet. Click "+ New Note" to get started.'
              : 'No notes match the selected filters.'}</p>
          </div>
        )}
        {viewMode === 'list' ? (
          <div className="list-view">
            {dayGroups.map(([day, daySessions]) => (
              <div key={day} className="list-day-group">
                <div className="list-day-label">{day}</div>
                {daySessions.map((s, idx) => (
                  <ListRow key={s.id} rowNumber={idx + 1} session={s} expandedListId={expandedListId} setExpandedListId={setExpandedListId} {...sessionRowProps} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          dayGroups.map(([day, daySessions]) => (
            <div key={day} className="card-day-group">
              <div className="card-day-label">{day}</div>
              {daySessions.map(s => (
                <SessionCard key={s.id} session={s} {...sessionRowProps} />
              ))}
            </div>
          ))
        )}
        {paginationBar}
      </div>
    </div>
    </ConfigContext.Provider>
  );
}