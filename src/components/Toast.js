import React from 'react';

export function Toast({ message, type, href }) {
  return (
    <div className={`toast toast-${type}`}>
      {href
        ? <a href={href} target="_blank" rel="noreferrer" className="toast-link">{message}</a>
        : message}
    </div>
  );
}
