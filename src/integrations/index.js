// Integration adapter registry.
//
// Every external system has two adapters with the same interface:
//   <name>/real.js  talks to the vendor API using credentials from .env
//   <name>/mock.js  returns canned data from ../fixtures, no network, no credentials
//
// MOCK_INTEGRATIONS (default true) picks which one the server loads. Callers
// never import an adapter directly; they import from this module so swapping
// real and mock is a one-line environment change.

const useMock = String(process.env.MOCK_INTEGRATIONS ?? 'true').trim().toLowerCase() !== 'false';

function load(name) {
  return require(`./${name}/${useMock ? 'mock' : 'real'}`);
}

module.exports = {
  isMock: useMock,
  zendesk: load('zendesk'),
};
