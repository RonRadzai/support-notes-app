import React from 'react';
import { Lookup } from './Lookup';

export function UserLookup({ value, users, onType, onSelect, required }) {
  return (
    <Lookup
      value={value} items={users} onType={onType} onSelect={onSelect} required={required}
      getLabel={u => u.customer_name}
      getKey={u => `${u.customer_name}-${u.customer_email}-${u.org_name}`}
      renderItem={u => (
        <>
          <span className="org-dropdown-name">{u.customer_name}{u.org_name ? ` — ${u.org_name}` : ''}</span>
          {u.customer_email && <span className="org-dropdown-acct">{u.customer_email}</span>}
        </>
      )}
    />
  );
}
