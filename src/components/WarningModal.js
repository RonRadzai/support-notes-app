import React from 'react';

export function WarningModal({ messages, onClose }) {
  if (!messages.length) return null;
  return (
    <div className="warning-modal-overlay">
      <div className="warning-modal">
        <div className="warning-modal-title">Lookup Conflict</div>
        {messages.map((m, i) => <p key={i}>{m}</p>)}
        <button className="warning-modal-ok" onClick={onClose}>OK</button>
      </div>
    </div>
  );
}
