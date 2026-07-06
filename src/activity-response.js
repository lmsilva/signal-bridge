function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSpokenResponse(activity) {
  const candidates = [
    activity?.alexaResponse,
    activity?.answer,
    activity?.spokenText,
    activity?.cardResponse,
    activity?.description?.transcript,
    activity?.description?.text,
    activity?.description?.narrative,
    activity?.description?.content,
  ];

  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (text) {
      return text;
    }
  }

  return '';
}

module.exports = {
  normalizeText,
  extractSpokenResponse,
};
