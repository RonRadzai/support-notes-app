import React, { useState, useRef } from 'react';
import { API, STATUS_COLORS, emptyIssue } from '../constants';
import { parseDate, autoResize, useEscape, useCtrlS, buildIssueFormData, toDateInputValue, todayInputValue } from '../utils';
import { IssueCard } from './IssueCard';
import { IssueForm } from './IssueForm';
import { KebabMenu } from './KebabMenu';
import { OrgLookup } from './OrgLookup';
import { UserLookup } from './UserLookup';
import { ZendeskModal } from './ZendeskModal';
import { SyncBadge } from './SyncBadge';

const toEditData = s => ({
  customer_name: s.customer_name,
  org_name: s.org_name,
  account_number: s.account_number || '',
  crm_org_id: s.crm_org_id || '',
  customer_email: s.customer_email || '',
  notes: s.notes || '',
  date: toDateInputValue(s.date_created)
});

export function SessionCard({ session, onRefresh, onViewScreenshot, showToast, showWarning, platforms, orgs = [], users = [], displayName = '', onChangeName, defaultExpanded = false }) {
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [newIssue, setNewIssue] = useState({ ...emptyIssue });
  const [newIssueScreenshots, setNewIssueScreenshots] = useState([]);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [savingSession, setSavingSession] = useState(false);
  const [savingIssue, setSavingIssue] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // null when closed; otherwise { preselect } — preselect is an issue-id array
  // to pre-check (per-issue button), or undefined to pre-check all (kebab).
  const [zdModal, setZdModal] = useState(null);
  const [editData, setEditData] = useState(() => toEditData(session));
  const issueRefs = useRef(new Map());
  const editFormRef = useRef(null);

  const saveAll = async () => {
    setSavingSession(true);
    try {
      // `date` is a UI-only field; send date_created only when the day changed
      // so an untouched edit preserves the original creation timestamp.
      const { date, ...sessionFields } = editData;
      const body = date && date !== toDateInputValue(session.date_created)
        ? { ...sessionFields, date_created: date }
        : sessionFields;
      const res = await fetch(`${API}/api/sessions/${session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      await Promise.all([...issueRefs.current.values()].map(r => r?.save()));
      setEditing(false);
      setCollapsed(false);
      onRefresh();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (data.warnings?.length) showWarning(data.warnings);
      else showToast('Session updated');
    } catch (e) {
      console.error(e);
      showToast(`Failed to update session: ${e.message}`, 'error');
    } finally {
      setSavingSession(false);
    }
  };

  const cancelEdit = React.useCallback(() => {
    const dirty = JSON.stringify(editData) !== JSON.stringify(toEditData(session));
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setEditData(toEditData(session));
    setEditing(false);
  }, [session, editData]);

  const syncNow = async () => {
    try {
      const res = await fetch(`${API}/api/sessions/${session.id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      onRefresh();
      if (data.success) showToast('Synced to helpdesk');
      else showToast(`Helpdesk sync failed: ${data.last_zendesk_sync_error}`, 'error');
    } catch (e) {
      console.error(e);
      showToast(`Helpdesk sync failed: ${e.message}`, 'error');
    }
  };

  const deleteSession = async () => {
    try {
      await fetch(`${API}/api/sessions/${session.id}`, { method: 'DELETE' });
      onRefresh();
      showToast('Session deleted');
    } catch (e) {
      console.error(e);
      showToast('Failed to delete session', 'error');
    }
  };

  const addIssue = async (e) => {
    e.preventDefault();
    setSavingIssue(true);
    const issueToSend = { ...newIssue, platform: newIssue.platform || platforms[0]?.name || '', order_number: newIssue.order_number.split(',').filter(n => n.trim()).join(',') };
    const fd = buildIssueFormData(issueToSend, { sessionId: session.id, files: newIssueScreenshots });
    try {
      const res = await fetch(`${API}/api/issues`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      setNewIssue({ ...emptyIssue });
      setNewIssueScreenshots([]);
      setShowIssueForm(false);
      onRefresh();
      showToast('Issue added');
    } catch (e) {
      console.error(e);
      showToast(`Failed to add issue: ${e.message}`, 'error');
    } finally {
      setSavingIssue(false);
    }
  };

  useEscape(cancelEdit, editing);
  useCtrlS(() => editFormRef.current?.requestSubmit(), editing && !savingSession);

  if (editing) return (
    <div className="session-card editing">
      <form ref={editFormRef} onSubmit={e => { e.preventDefault(); saveAll(); }}>
      <div className="field field--date">
        <label>Note Date</label>
        <input type="date" max={todayInputValue()}
          value={editData.date}
          onChange={e => setEditData({ ...editData, date: e.target.value })} />
      </div>
      <div className="form-row">
        <div className="field">
          <label>Customer Name <span className="req">*</span></label>
          <UserLookup
            required
            value={editData.customer_name}
            users={users}
            onType={v => setEditData({ ...editData, customer_name: v })}
            onSelect={u => {
              const org = orgs.find(o => o.account_number && o.account_number === u.account_number);
              setEditData({
                ...editData,
                customer_name: u.customer_name,
                customer_email: u.customer_email,
                org_name: u.org_name || (org ? org.name : editData.org_name),
                account_number: u.account_number || editData.account_number,
                crm_org_id: org ? org.crm_org_id : editData.crm_org_id,
              });
            }}
          />
        </div>
        <div className="field">
          <label>Customer Email</label>
          <input type="email" value={editData.customer_email}
            onChange={e => setEditData({ ...editData, customer_email: e.target.value })} />
        </div>
      </div>
      <div className="form-row-3">
        <div className="field">
          <label>Organization Name <span className="req">*</span></label>
          <OrgLookup
            required
            value={editData.org_name}
            orgs={orgs}
            onType={v => setEditData({ ...editData, org_name: v })}
            onSelect={org => setEditData({ ...editData, org_name: org.name, account_number: org.account_number, crm_org_id: org.crm_org_id })}
          />
        </div>
        <div className="field">
          <label>Account #</label>
          <input value={editData.account_number}
            onChange={e => {
              const v = e.target.value;
              const match = v.trim() ? orgs.find(o => o.account_number === v.trim()) : null;
              setEditData(match ? { ...editData, account_number: v, org_name: match.name, crm_org_id: match.crm_org_id } : { ...editData, account_number: v });
            }} />
        </div>
        <div className="field">
          <label>CRM Org ID</label>
          <input value={editData.crm_org_id}
            onChange={e => setEditData({ ...editData, crm_org_id: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Session Notes</label>
        <textarea className="auto-expand" value={editData.notes}
          ref={el => autoResize(el)}
          onChange={e => setEditData({ ...editData, notes: e.target.value })}
          onInput={e => autoResize(e.target)} />
      </div>
      <div className="edit-actions">
        <button type="submit" className="btn-save" disabled={savingSession}>
          {savingSession ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={cancelEdit} className="btn-cancel">Cancel</button>
      </div>
      </form>
      {session.issues?.length > 0 && (
        <div className="issues-section" style={{ marginTop: '16px' }}>
          <h4>Issues ({session.issues.length})</h4>
          <div className="issues-list">
            {[...session.issues].sort((a, b) => (b.status === 'Flagged for Review' ? 1 : 0) - (a.status === 'Flagged for Review' ? 1 : 0)).map((iss, idx) => (
              <IssueCard key={iss.id} ref={el => { if (el) issueRefs.current.set(iss.id, el); else issueRefs.current.delete(iss.id); }} issue={iss} session={session} onRefresh={onRefresh} onViewScreenshot={onViewScreenshot} showToast={showToast} platforms={platforms} displayName={displayName} onChangeName={onChangeName} issueIndex={idx} showNumber={session.issues.length > 1} initiallyEditing={true} embedded={true} />
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const hasFlag = (session.issues || []).some(i => i.status === 'Flagged for Review');
  const cardStatuses = (session.issues || []).map(i => i.status);
  const cardHasEscalated = cardStatuses.some(s => s === 'Escalated');
  const cardAllSolved = cardStatuses.length > 0 && cardStatuses.every(s => s === 'Solved');
  const cardBorderColor = cardHasEscalated ? '#e53935' : hasFlag ? '#ff9800' : cardAllSolved ? '#43a047' : '#42a5f5';

  const copyNote = () => {
    const lines = [];
    if (session.customer_name) lines.push(session.customer_name);
    if (session.org_name) lines.push(session.org_name);
    if (session.account_number) lines.push('Acct #' + session.account_number);
    if (session.customer_email) lines.push(session.customer_email);
    if (session.crm_org_id) lines.push('CRM: ' + session.crm_org_id);
    if (session.notes) lines.push(session.notes);
    const issues = session.issues || [];
    issues.forEach((iss, idx) => {
      lines.push('');
      if (issues.length > 1) lines.push(`Issue ${idx + 1}`);
      if (iss.platform) lines.push('[' + iss.platform + ']');
      if (iss.description) lines.push(iss.description);
      if (iss.order_number) iss.order_number.split(',').filter(n => n.trim()).forEach(n => lines.push('Order #' + n.trim()));
      if (iss.zendesk_ticket) lines.push('Zendesk: #' + iss.zendesk_ticket);
      if (iss.resolution) lines.push('Resolution: ' + iss.resolution);
    });
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard');
    }
  };

  return (
    <div className={`session-card${collapsed ? ' collapsed' : ''}${hasFlag ? ' session-card--flagged' : ''}`} style={{ borderLeftColor: cardBorderColor }}>
      <div className="session-header" onClick={() => setCollapsed(c => !c)} style={{ cursor: 'pointer' }} role="button" aria-expanded={!collapsed}>
        <div>
          <h3>
            {hasFlag && <span className="session-flagged-icon">⚑</span>}
            {session.customer_name} — {session.org_name}
            {session.account_number && <span className="acct-inline"> · {session.account_number}</span>}
          </h3>
          <div className="session-meta">
            {session.crm_org_id && <span>CRM: {session.crm_org_id}</span>}
            {session.customer_email && <span>{session.customer_email}</span>}
            <SyncBadge session={session} />
          </div>
          {collapsed && (
            <div className="session-summary">
              {!session.issues?.length
                ? <span className="summary-empty">No issues logged</span>
                : ['Pending', 'Flagged for Review', 'Escalated', 'Solved'].map(status => {
                    const count = session.issues.filter(i => i.status === status).length;
                    return count ? (
                      <span key={status} className={`summary-chip${status === 'Flagged for Review' ? ' summary-chip--flagged' : ''}`} style={{ background: STATUS_COLORS[status] }}>
                        {count} {status}
                      </span>
                    ) : null;
                  })
              }
            </div>
          )}
        </div>
        <div className="session-header-right" onClick={e => e.stopPropagation()}>
          <span className="session-date">{parseDate(session.date_created).toLocaleDateString()}</span>
          <span className="session-chevron" onClick={() => setCollapsed(c => !c)} style={{ cursor: 'pointer' }}>{collapsed ? '▶ Click to expand' : '▼ Click to collapse'}</span>
          <KebabMenu items={[
            { label: 'Edit', action: () => { setEditData(toEditData(session)); setEditing(true); } },
            { label: 'Copy Note in Plain Text', action: copyNote },
            { label: 'Create Zendesk Ticket', action: () => setZdModal({}), disabled: !(session.issues?.length > 0) },
            { label: 'Sync to helpdesk', action: syncNow },
            { label: 'Delete', action: () => setConfirmDelete(true), danger: true }
          ]} />
        </div>
      </div>

      {confirmDelete && (
        <div className="delete-confirm">
          <span>Are you sure?</span>
          <div className="delete-confirm-actions">
            <button className="btn-danger-confirm" onClick={deleteSession}>Delete</button>
            <button className="btn-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!collapsed && session.notes && <p className="session-notes"><strong>Session Notes:</strong> {session.notes}</p>}

      {!collapsed && (
        <div className="issues-section">
          <div className="issues-header">
            <h4>Issues ({session.issues?.length || 0})</h4>
            <button className="add-issue-btn" onClick={() => setShowIssueForm(!showIssueForm)}>
              {showIssueForm ? 'Cancel' : '+ Add Issue'}
            </button>
          </div>

          {showIssueForm && (
            <form onSubmit={addIssue} className="issue-form">
              <IssueForm
                data={newIssue}
                onChange={setNewIssue}
                platforms={platforms}
                screenshots={newIssueScreenshots}
                onScreenshotsChange={setNewIssueScreenshots}
              />
              <div className="edit-actions">
                <button type="submit" className="btn-save" disabled={savingIssue}>
                  {savingIssue ? 'Saving...' : 'Save'}
                </button>
                <button type="button" className="btn-cancel" onClick={() => { setNewIssue({ ...emptyIssue }); setNewIssueScreenshots([]); setShowIssueForm(false); }}>Cancel</button>
              </div>
            </form>
          )}

          <div className="issues-list">
            {[...(session.issues || [])].sort((a, b) => (b.status === 'Flagged for Review' ? 1 : 0) - (a.status === 'Flagged for Review' ? 1 : 0)).map((iss, idx) => (
              <IssueCard key={iss.id} issue={iss} session={session} onRefresh={onRefresh} onViewScreenshot={onViewScreenshot} onCreateTicket={id => setZdModal({ preselect: [id] })} showToast={showToast} platforms={platforms} displayName={displayName} onChangeName={onChangeName} issueIndex={idx} showNumber={(session.issues?.length || 0) > 1} />
            ))}
          </div>
        </div>
      )}

      {zdModal && (
        <ZendeskModal
          session={session}
          initialSelectedIds={zdModal.preselect}
          onClose={() => setZdModal(null)}
          onCreated={onRefresh}
          showToast={showToast}
        />
      )}
    </div>
  );
}
