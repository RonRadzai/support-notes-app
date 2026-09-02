import React, { useState, useRef, useEffect } from 'react';

export function KebabMenu({ items, style }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="kebab-menu" ref={ref} style={style}>
      <button className="kebab-btn" onClick={() => setOpen(!open)}>⋮</button>
      {open && (
        <div className="kebab-dropdown">
          {items.map(item => (
            <button
              key={item.label}
              className={`kebab-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`}
              onClick={() => { if (!item.disabled) { item.action(); setOpen(false); } }}
              disabled={item.disabled}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
