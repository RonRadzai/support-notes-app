import React, { useState } from 'react';

export function PlatformManager({ platforms, onSave, onClose }) {
  const [list, setList] = useState([...platforms]);
  const [newName, setNewName] = useState('');

  const add = () => {
    const name = newName.trim();
    if (!name || list.some(p => p.name === name)) return;
    setList([...list, { name }]);
    setNewName('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Manage Platforms</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p className="modal-section-label">Current Platforms</p>
          <div className="platform-list">
            {list.map((p, i) => (
              <div key={p.id || p.name} className="platform-item">
                <span>{p.name}</span>
                {p.locked
                  ? <span className="platform-locked">Default</span>
                  : <button
                      className="platform-remove"
                      onClick={() => setList(list.filter((_, j) => j !== i))}
                    >×</button>
                }
              </div>
            ))}
          </div>
          <div className="platform-add-row">
            <input
              type="text"
              placeholder="New platform name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
            />
            <button className="btn-save" onClick={add} disabled={!newName.trim()}>Add</button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="submit-btn" style={{ marginTop: 0 }} onClick={() => { onSave(list); onClose(); }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
