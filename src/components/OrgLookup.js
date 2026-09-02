import React from 'react';
import { Lookup } from './Lookup';

export function OrgLookup({ value, orgs, onType, onSelect, required }) {
  return (
    <Lookup
      value={value} items={orgs} onType={onType} onSelect={onSelect} required={required}
      getLabel={o => o.name}
      getKey={o => o.account_number || o.name}
      renderItem={o => (
        <>
          <span className="org-dropdown-name">{o.name}</span>
          {o.account_number && <span className="org-dropdown-acct">#{o.account_number}</span>}
        </>
      )}
    />
  );
}
