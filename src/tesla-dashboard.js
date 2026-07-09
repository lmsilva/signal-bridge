const TESLA_DASHBOARD_QUERY_RE = /\b(?:show|open|display|pull\s+up)\s+(?:me\s+)?(?:my\s+)?tesla\s+dashboard\b|\btesla\s+dashboard\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesTeslaDashboardQuery(summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  return TESLA_DASHBOARD_QUERY_RE.test(text) || TESLA_DASHBOARD_QUERY_RE.test(spoken);
}

module.exports = {
  TESLA_DASHBOARD_QUERY_RE,
  matchesTeslaDashboardQuery,
};
