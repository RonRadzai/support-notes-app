import { createContext } from 'react';

// Runtime settings the API exposes at GET /api/config. App fetches them once on
// load and provides them here so deep components (ticket links, sync badges) can
// read them without prop drilling.
export const defaultConfig = {
  mock_integrations: true,
  helpdesk_enabled: true,
  ticket_url_base: '#',
};

export const ConfigContext = createContext(defaultConfig);
