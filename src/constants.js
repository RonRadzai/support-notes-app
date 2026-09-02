// API base URL prefix for every fetch. Empty string means relative URLs, which work in
// both modes: the CRA dev server proxies /api/* to the backend (see "proxy" in
// package.json), and the production build is served by the same Express process.
export const API = '';
export const COMMENT_TEAMS = ['Support Team', 'Development Team', 'Accounts Team'];
export const STATUS_COLORS = { Pending: '#42a5f5', 'Flagged for Review': '#ff9800', Solved: '#9e9e9e', Escalated: '#e53935' };
export const emptySession = {
  customer_name: '', org_name: '', account_number: '',
  crm_org_id: '', customer_email: '', notes: ''
};
export const emptyIssue = {
  platform: '', description: '',
  status: 'Pending', resolution: '', order_number: '', zendesk_ticket: ''
};
