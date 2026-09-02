import React, { useState, useRef, useEffect } from 'react';

// Generic typeahead used by OrgLookup and UserLookup.
// Filters on getLabel's text, sorts newest account number first, shows top 8.
export function Lookup({ value, items, onType, onSelect, required, getLabel, getKey, renderItem }) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const wrapRef = useRef(null);

  const term = value.toLowerCase();
  const matches = term.length >= 2
    ? items.filter(it => getLabel(it).toLowerCase().includes(term))
        .sort((a, b) => Number(b.account_number) - Number(a.account_number))
        .slice(0, 8)
    : [];

  useEffect(() => {
    const handler = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const select = item => { onSelect(item); setOpen(false); };

  const handleKey = e => {
    if (!open || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted(h => Math.min(h + 1, matches.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    if (e.key === 'Enter' && matches[highlighted]) { e.preventDefault(); select(matches[highlighted]); }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="org-lookup" ref={wrapRef}>
      <input
        type="text"
        required={required}
        value={value}
        onChange={e => { onType(e.target.value); setOpen(true); setHighlighted(0); }}
        onFocus={() => { if (value.length >= 2) setOpen(true); }}
        onKeyDown={handleKey}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <ul className="org-dropdown">
          {matches.map((item, i) => (
            <li key={getKey(item)}
              className={i === highlighted ? 'active' : ''}
              onMouseDown={() => select(item)}>
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
