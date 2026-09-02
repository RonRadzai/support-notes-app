// Fixtures store times as offsets from "now" so mock data always looks current.

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

module.exports = { daysAgoIso };
