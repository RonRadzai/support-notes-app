import React, { useRef, useEffect } from 'react';
import { STATUS_COLORS } from '../constants';
import { SessionCard } from './SessionCard';
import { SyncBadge } from './SyncBadge';

export function ListRow({ session, expandedListId, setExpandedListId, rowNumber, ...props }) {
  const expanded = expandedListId === session.id;
  const statuses = (session.issues || []).map(i => i.status);
  const hasEscalated = statuses.includes('Escalated');
  const hasFlagged = statuses.includes('Flagged for Review');
  const allSolved = statuses.length > 0 && statuses.every(s => s === 'Solved');
  const rowColor = hasEscalated ? '#e53935' : hasFlagged ? '#ff9800' : allSolved ? '#43a047' : '#42a5f5';
  const expandedRef = useRef(null);
  const rowHeaderRef = useRef(null);
  const prevExpanded = useRef(expanded);
  useEffect(() => {
    if (expanded && expandedRef.current) {
      expandedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (!expanded && prevExpanded.current && rowHeaderRef.current) {
      rowHeaderRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    prevExpanded.current = expanded;
  }, [expanded]);
  return (
    <div className="list-row-wrap">
      <div className="list-row-header" ref={rowHeaderRef}>
        <span className="list-row-num">{rowNumber}</span>
        <div className={`list-row${expanded ? ' list-row--expanded' : ''}`} onClick={() => setExpandedListId(expanded ? null : session.id)} style={{ borderLeftColor: rowColor, backgroundColor: hasEscalated ? 'rgba(229,57,53,0.07)' : hasFlagged ? 'rgba(255,152,0,0.07)' : undefined, outline: hasEscalated ? '1px solid rgba(229,57,53,0.4)' : hasFlagged ? '1px solid rgba(255,152,0,0.4)' : undefined }}>
          <div className="list-row-main">
            {hasFlagged && <span className="session-flagged-icon">⚑</span>}
            <span className="list-row-name">{session.customer_name}</span>
            {session.org_name && <span className="list-row-org"> — {session.org_name}</span>}
            {session.account_number && <span className="list-row-acct"> · {session.account_number}</span>}
          </div>
          <div className="list-row-right">
            <div className="summary-chips">
              <SyncBadge session={session} compact />
              {Object.entries(
                (session.issues || []).reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {})
              ).map(([status, count]) => (
                <span key={status} className={`summary-chip${status === 'Flagged for Review' ? ' summary-chip--flagged' : ''}`} style={{ background: STATUS_COLORS[status] }}>
                  {count} {status}
                </span>
              ))}
            </div>
            <span className="list-row-chevron">{expanded ? '▼' : '▶'}</span>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="list-row-expanded" ref={expandedRef}>
          <SessionCard session={session} {...props} defaultExpanded={true} />
        </div>
      )}
    </div>
  );
}
