const TESLA_DASHBOARD_QUERY_RE = /\b(?:show|open|display|pull\s+up)\s+(?:me\s+)?(?:my\s+)?tesla\s+dashboard\b|\btesla\s+dashboard\b/i;
const SENT_TO_DISPLAY_RE = /\bsent\s+to\s+(?:your\s+)?display\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesTeslaDashboardQuery(summary, response) {
  const text = normalizeText(summary);
  const spoken = normalizeText(response);
  if (TESLA_DASHBOARD_QUERY_RE.test(text) || TESLA_DASHBOARD_QUERY_RE.test(spoken)) {
    return true;
  }
  // Claim Sent to Display only when dashboard is mentioned (routine-index
  // handles the ambiguous empty-summary case).
  if (SENT_TO_DISPLAY_RE.test(spoken) && /\bdashboard\b/i.test(`${text} ${spoken}`)) {
    return true;
  }
  return false;
}

module.exports = {
  TESLA_DASHBOARD_QUERY_RE,
  matchesTeslaDashboardQuery,
};
