import React, { useState } from 'react';
import { API, STATUS_COLORS } from '../constants';
import { parseDate, useEscape } from '../utils';

// Create-a-Zendesk-ticket dialog. Reused from two places:
//  - SessionCard (kebab item + per-issue "Create Ticket" button)
//  - App new-note flow (after "Save & Create Zendesk Ticket")
// `initialSelectedIds` pre-checks a subset of issues; omit it to pre-check all.
export function ZendeskModal({ session, initialSelectedIds, onClose, onCreated, showToast }) {
  const [selectedIds, setSelectedIds] = useState(
    () => initialSelectedIds ?? (session.issues || []).map(i => i.id)
  );
  const [subject, setSubject] = useState(() => {
    const date = parseDate(session.date_created).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
    return `Support Session Follow Up ${date}`;
  });
  const [submitting, setSubmitting] = useState(false);

  useEscape(() => { if (!submitting) onClose(); });

  const submit = async () => {
    if (selectedIds.length === 0) { showToast('Select at least one issue', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/zendesk/create-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id, issue_ids: selectedIds, subject }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onCreated();
      onClose();
      showToast(`Ticket #${data.ticket_id} created. Open in Zendesk`, 'success', data.ticket_url);
    } catch (e) {
      showToast(e.message || 'Failed to create Zendesk ticket', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="zd-modal-overlay" onClick={() => !submitting && onClose()}>
      <div className="zd-modal" onClick={e => e.stopPropagation()}>
        <h3 className="zd-modal-title"><span className="zd-logo zd-logo--title" aria-hidden="true" />Create Zendesk Ticket</h3>

        <label className="zd-label">Subject</label>
        <input
          className="zd-subject-input"
          value={subject}
          onChange={e => setSubject(e.target.value)}
          maxLength={300}
          disabled={submitting}
        />

        <label className="zd-label">Issues to include</label>
        <div className="zd-issue-list">
          {(session.issues || []).map(iss => {
            const checked = selectedIds.includes(iss.id);
            const alreadyLinked = !!iss.zendesk_ticket;
            return (
              <label key={iss.id} className={`zd-issue-row${alreadyLinked ? ' zd-issue-row--linked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={submitting}
                  onChange={() => setSelectedIds(ids =>
                    ids.includes(iss.id) ? ids.filter(x => x !== iss.id) : [...ids, iss.id]
                  )}
                />
                <span className="zd-issue-platform">{iss.platform}</span>
                <span className="zd-issue-desc">{iss.description?.slice(0, 80)}{iss.description?.length > 80 ? '…' : ''}</span>
                <span className="zd-issue-status" style={{ background: STATUS_COLORS[iss.status] || '#90a4ae' }}>{iss.status}</span>
                {alreadyLinked && <span className="zd-issue-linked">#{iss.zendesk_ticket}</span>}
              </label>
            );
          })}
        </div>

        <p className="zd-note">Ticket will be created as <strong>New</strong> with an internal note. No customer notification until an agent replies in Zendesk.</p>

        <div className="zd-modal-actions">
          <button className="btn-save" onClick={submit} disabled={submitting || selectedIds.length === 0}>
            {submitting ? 'Creating…' : 'Create Ticket'}
          </button>
          <button className="btn-cancel" onClick={onClose} disabled={submitting}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
