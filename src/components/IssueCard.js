import React, { useState, useEffect, useRef, useContext } from 'react';
import { ConfigContext } from '../config';
import { API, STATUS_COLORS, COMMENT_TEAMS } from '../constants';
import { parseDate, screenshotUrl, useEscape, useCtrlS, buildIssueFormData } from '../utils';
import { IssueForm } from './IssueForm';
import { KebabMenu } from './KebabMenu';

export const IssueCard = React.forwardRef(function IssueCard({ issue, session, onRefresh, onViewScreenshot, onCreateTicket, showToast, platforms, displayName = '', onChangeName, issueIndex = 0, showNumber = false, initiallyEditing = false, embedded = false }, ref) {
  const config = useContext(ConfigContext);
  const [editing, setEditing] = useState(initiallyEditing);
  const [d, setD] = useState({ ...issue });
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [showScreenshots, setShowScreenshots] = useState(false);
  const [editScreenshots, setEditScreenshots] = useState([]);
  const [savingIssue, setSavingIssue] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showResolvedPrompt, setShowResolvedPrompt] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [sessionNotes, setSessionNotes] = useState(session.notes || '');
  const [focusResolution, setFocusResolution] = useState(false);
  const resolutionRef = useRef(null);
  const issueFormRef = useRef(null);
  const [existingPaths, setExistingPaths] = useState(
    issue.screenshots ? issue.screenshots.split(',').filter(Boolean) : []
  );

  useEffect(() => {
    if (!editing) {
      setExistingPaths(issue.screenshots ? issue.screenshots.split(',').filter(Boolean) : []);
    }
  }, [issue.screenshots, editing]);

  const cancelIssueEdit = () => {
    const dirty = JSON.stringify(d) !== JSON.stringify(issue)
      || editScreenshots.length > 0
      || (!embedded && sessionNotes !== (session.notes || ''));
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setD({ ...issue });
    setEditScreenshots([]);
    setEditing(false);
  };

  useEscape(cancelIssueEdit, editing);
  useCtrlS(() => issueFormRef.current?.requestSubmit(), editing && !embedded && !savingIssue);

  useEffect(() => {
    if (editing && focusResolution && resolutionRef.current) {
      resolutionRef.current.focus();
      setFocusResolution(false);
    }
  }, [editing, focusResolution]);

  React.useImperativeHandle(ref, () => ({ save }));

  const quickUpdateStatus = async (newStatus) => {
    setStatusUpdating(true);
    try {
      const fd = buildIssueFormData({ ...issue, status: newStatus }, { existingScreenshots: issue.screenshots || '' });
      const res = await fetch(`${API}/api/issues/${issue.id}`, { method: 'PUT', body: fd });
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      onRefresh();
    } catch (e) {
      console.error(e);
      showToast('Failed to update issue', 'error');
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleQuickResolved = () => {
    if (issue.status === 'Solved') {
      quickUpdateStatus('Pending');
    } else {
      setShowResolvedPrompt(true);
    }
  };

  const deleteIssue = async () => {
    try {
      const res = await fetch(`${API}/api/issues/${issue.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      onRefresh();
      showToast('Issue deleted');
    } catch (e) {
      console.error(e);
      showToast('Failed to delete issue', 'error');
    }
  };

  const save = async () => {
    setSavingIssue(true);
    try {
      const saveData = { ...d, order_number: d.order_number ? d.order_number.split(',').filter(n => n.trim()).join(',') : '' };
      const fd = buildIssueFormData(saveData, { existingScreenshots: existingPaths.join(','), files: editScreenshots });
      const res = await fetch(`${API}/api/issues/${issue.id}`, { method: 'PUT', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      if (!embedded && sessionNotes !== (session.notes || '')) {
        const sRes = await fetch(`${API}/api/sessions/${session.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...session, notes: sessionNotes })
        });
        const sData = await sRes.json().catch(() => ({}));
        if (!sRes.ok) throw new Error(sData.error || `Server error (${sRes.status})`);
      }
      setEditScreenshots([]);
      setEditing(false);
      if (!embedded) {
        onRefresh();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        showToast('Issue updated');
      }
    } catch (e) {
      console.error(e);
      showToast(`Failed to update issue: ${e.message}`, 'error');
    } finally {
      setSavingIssue(false);
    }
  };

  const screenshotCount = issue.screenshots ? issue.screenshots.split(',').filter(Boolean).length : 0;

  if (editing) return (
    <div className="issue-card editing">
      <form ref={issueFormRef} onSubmit={e => { e.preventDefault(); save(); }}>
      <IssueForm
        data={d}
        onChange={setD}
        platforms={platforms}
        screenshots={editScreenshots}
        onScreenshotsChange={setEditScreenshots}
        existingPaths={existingPaths}
        onRemoveExistingPath={p => setExistingPaths(existingPaths.filter(ep => ep !== p))}
        sessionNotes={!embedded ? sessionNotes : undefined}
        onSessionNotesChange={!embedded ? setSessionNotes : undefined}
        resolutionRef={resolutionRef}
      />
      {!embedded && (
        <div className="edit-actions">
          <button type="submit" className="btn-save" disabled={savingIssue}>
            {savingIssue ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={cancelIssueEdit} className="btn-cancel">Cancel</button>
        </div>
      )}
      </form>
    </div>
  );

  return (
    <div className="issue-card">
      {showNumber && <div className="issue-number-label">Issue {issueIndex + 1}</div>}
      <div className="issue-header">
        <span className="platform-badge">{issue.platform}</span>
        {issue.status === 'Flagged for Review'
          ? <span className="issue-flag-icon">⚑</span>
          : <span className="status-badge" style={{ backgroundColor: STATUS_COLORS[issue.status] }}>{issue.status}</span>
        }
        <span className="issue-date">{parseDate(issue.date_created).toLocaleDateString()}</span>
        <KebabMenu style={{ marginLeft: 'auto' }} items={[
          { label: 'Edit', action: () => { setD({ ...issue }); setEditing(true); } },
          { label: 'Delete', action: () => setConfirmDelete(true), danger: true }
        ]} />
      </div>
      <p className="issue-description">{issue.description}</p>
      {issue.order_number && issue.order_number.split(',').filter(n => n.trim()).map((n, i) => (
        <p key={i} className="detail-line"><strong>Order Number:</strong> {n.trim()}</p>
      ))}
      {issue.zendesk_ticket && (
        <p className="detail-line"><strong>Zendesk:</strong> <a href={`${config.ticket_url_base}/${issue.zendesk_ticket}`} target="_blank" rel="noreferrer" className="zendesk-link">#{issue.zendesk_ticket}</a></p>
      )}
      {issue.resolution && (
        <div className="resolution"><strong>Resolution:</strong> {issue.resolution}</div>
      )}
      {issue.escalation_recipients && (
        <div className="escalation-info"><strong>Escalated to:</strong> {issue.escalation_recipients}</div>
      )}
      {screenshotCount > 0 && (
        <>
          <button className="screenshots-toggle" onClick={() => setShowScreenshots(!showScreenshots)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign:'middle',marginRight:'5px',marginBottom:'1px'}}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            {screenshotCount} screenshot{screenshotCount !== 1 ? 's' : ''} {showScreenshots ? '▲' : '▼'}
          </button>
          {showScreenshots && (
            <div className="screenshot-grid">
              {issue.screenshots.split(',').filter(Boolean).map((path, i) => (
                <button key={i} type="button" className="screenshot-thumb-btn" onClick={() => onViewScreenshot && onViewScreenshot(path)}>
                  <img src={screenshotUrl(path)} alt={`Screenshot ${i + 1}`} className="screenshot-thumb" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="comments-section">
        <button className="comments-toggle" onClick={() => setShowComments(v => !v)}>
          &#128172; {(issue.comments || []).length} Comment{(issue.comments || []).length !== 1 ? 's' : ''} {showComments ? '▲' : '▼'}
        </button>
        {showComments && (
          <div className="comments-body">
            {(issue.comments || []).length === 0 && <p className="comments-empty">No comments yet.</p>}
            {(issue.comments || []).map(c => (
              <div key={c.id} className="comment">
                <div className="comment-meta">
                  <strong>{c.author}</strong>
                  <span>{parseDate(c.date_created).toLocaleString()}</span>
                  <button className="comment-delete" title="Delete comment" onClick={async () => {
                    if (!window.confirm('Delete this comment?')) return;
                    try {
                      const res = await fetch(`${API}/api/comments/${c.id}`, { method: 'DELETE' });
                      if (!res.ok) throw new Error(`Server error (${res.status})`);
                      onRefresh();
                    } catch (e) {
                      console.error(e);
                      showToast('Failed to delete comment', 'error');
                    }
                  }}>×</button>
                </div>
                <p className="comment-body">{c.body}</p>
              </div>
            ))}
            <div className="comment-form">
              <div className="comment-author-line">
                <label className="comment-team-label">Commenting as:</label>
                <select className="comment-team-select" value={displayName || ''} onChange={e => onChangeName(e.target.value)}>
                  <option value="">— Select team —</option>
                  {COMMENT_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <textarea className="comment-input" rows="2" placeholder="Add a comment…" value={commentText} onChange={e => setCommentText(e.target.value)} />
              <div className="comment-actions">
                <button className="btn-save comment-submit" disabled={submittingComment || !commentText.trim() || !displayName} onClick={async () => {
                  setSubmittingComment(true);
                  try {
                    await fetch(`${API}/api/issues/${issue.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: displayName, body: commentText.trim() }) });
                    setCommentText('');
                    onRefresh();
                  } finally { setSubmittingComment(false); }
                }}>
                  {submittingComment ? 'Posting…' : 'Post Comment'}
                </button>
                <button type="button" className="btn-cancel" onClick={() => { setCommentText(''); setShowComments(false); }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="card-actions">
        <button
          className={`card-status-btn flag-btn${issue.status === 'Flagged for Review' ? ' active' : ''}`}
          disabled={statusUpdating}
          onClick={() => quickUpdateStatus(issue.status === 'Flagged for Review' ? 'Pending' : 'Flagged for Review')}
        >{issue.status === 'Flagged for Review' ? 'Flagged for Review ⚑' : 'Flag for Review'}</button>
        {onCreateTicket && (
          <button
            type="button"
            className="card-status-btn zd-ticket-btn"
            title="Create Zendesk Ticket"
            onClick={() => onCreateTicket(issue.id)}
          ><span className="zd-logo zd-logo--inverse" aria-hidden="true" /> Create Ticket</button>
        )}
        <button
          className={`card-status-btn resolved-btn${issue.status === 'Solved' ? ' active' : ''}`}
          disabled={statusUpdating}
          onClick={handleQuickResolved}
        >{issue.status === 'Solved' ? 'Resolved ✓' : 'Resolved'}</button>
      </div>
      {showResolvedPrompt && (
        <div className="resolved-prompt">
          <span>Add resolution notes?</span>
          <div className="resolved-prompt-actions">
            <button className="btn-save" onClick={() => { setShowResolvedPrompt(false); setD({ ...issue, status: 'Solved' }); setFocusResolution(true); setEditing(true); }}>Yes, open editor</button>
            <button className="btn-cancel" onClick={() => { setShowResolvedPrompt(false); quickUpdateStatus('Solved'); }}>No, just resolve</button>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="delete-confirm">
          <span>Permanently delete this issue? This cannot be undone.</span>
          <div className="delete-confirm-actions">
            <button className="btn-danger-confirm" onClick={deleteIssue}>Delete</button>
            <button className="btn-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
});
