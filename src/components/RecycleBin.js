import React, { useState, useEffect } from 'react';
import { API } from '../constants';
import { parseDate } from '../utils';

export function RecycleBin({ onClose, onRestored, showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmPurge, setConfirmPurge] = useState(null);

  useEffect(() => {
    fetch(`${API}/api/recycle-bin`)
      .then(r => r.json())
      .then(data => { setItems(data); setLoading(false); })
      .catch(() => { showToast('Failed to load recycle bin', 'error'); setLoading(false); });
  }, [showToast]);

  const restore = async (id) => {
    await fetch(`${API}/api/recycle-bin/${id}/restore`, { method: 'POST' });
    onRestored();
  };

  const hardDelete = async (id) => {
    await fetch(`${API}/api/recycle-bin/${id}`, { method: 'DELETE' });
    setItems(prev => prev.filter(s => s.id !== id));
    setConfirmPurge(null);
    showToast('Permanently deleted');
  };

  const daysLeft = (deletedAt) => {
    const purgeDate = new Date(deletedAt.replace(' ', 'T') + 'Z');
    purgeDate.setDate(purgeDate.getDate() + 10);
    const days = Math.ceil((purgeDate - new Date()) / 86400000);
    return Math.max(0, days);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal recycle-bin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>♻️ Recycle Bin</h2>
          <p className="recycle-bin-subtitle">Deleted sessions are automatically purged after 10 days.</p>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {loading && <p className="recycle-empty">Loading…</p>}
          {!loading && items.length === 0 && <p className="recycle-empty">Recycle bin is empty.</p>}
          {items.map(s => (
            <div key={s.id} className="recycle-item">
              <div className="recycle-item-info">
                <div className="recycle-item-name">
                  {s.customer_name} — {s.org_name}
                  {s.account_number && <span className="recycle-item-acct"> · {s.account_number}</span>}
                </div>
                <div className="recycle-item-meta">
                  <span>Deleted {parseDate(s.deleted_at).toLocaleDateString()}</span>
                  <span className="recycle-days-left">{daysLeft(s.deleted_at)}d until auto-purge</span>
                  <span>{(s.issues || []).length} issue{(s.issues || []).length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="recycle-item-actions">
                <button className="btn-restore" onClick={() => restore(s.id)}>Restore</button>
                {confirmPurge === s.id ? (
                  <>
                    <span className="recycle-confirm-text">Permanently delete?</span>
                    <button className="btn-danger-confirm" onClick={() => hardDelete(s.id)}>Yes, delete</button>
                    <button className="btn-cancel" onClick={() => setConfirmPurge(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn-danger-sm" onClick={() => setConfirmPurge(s.id)}>Delete permanently</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
