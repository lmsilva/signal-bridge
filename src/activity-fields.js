/**
 * Harvest customer / Alexa / misc transcript text from history activities.
 *
 * alexa-remote2 only fills description.summary from CUSTOMER_TRANSCRIPT /
 * ASR_REPLACEMENT_TEXT. App-launched routines often leave those empty and
 * put useful text in other voiceHistoryRecordItems types.
 */

const { normalizeText, extractSpokenResponse } = require('./activity-response');

const CUSTOMER_ITEM_TYPES = new Set([
  'CUSTOMER_TRANSCRIPT',
  'ASR_REPLACEMENT_TEXT',
]);

const RESPONSE_ITEM_TYPES = new Set([
  'ALEXA_RESPONSE',
  'TTS_REPLACEMENT_TEXT',
]);

function pushUnique(list, value) {
  const text = normalizeText(value);
  if (!text || list.includes(text)) {
    return;
  }
  list.push(text);
}

function collectFromConversionDetails(conversionDetails, into) {
  if (!conversionDetails || typeof conversionDetails !== 'object') {
    return;
  }
  for (const [itemType, items] of Object.entries(conversionDetails)) {
    if (!Array.isArray(items)) {
      continue;
    }
    into.itemTypes.add(String(itemType));
    for (const item of items) {
      const text = item?.transcriptText ?? item?.text ?? item?.content ?? '';
      pushUnique(into.allParts, text);
      if (CUSTOMER_ITEM_TYPES.has(itemType)) {
        pushUnique(into.customerParts, text);
      } else if (RESPONSE_ITEM_TYPES.has(itemType)) {
        pushUnique(into.responseParts, text);
      } else if (text) {
        // Unknown types (cards, routine labels, etc.) — keep for matching.
        pushUnique(into.miscParts, text);
      }
    }
  }
}

function collectFromRecordItems(recordItems, into) {
  if (!Array.isArray(recordItems)) {
    return;
  }
  for (const item of recordItems) {
    const itemType = String(item?.recordItemType || item?.type || '');
    if (itemType) {
      into.itemTypes.add(itemType);
    }
    const text = item?.transcriptText ?? item?.text ?? item?.content ?? '';
    pushUnique(into.allParts, text);
    if (CUSTOMER_ITEM_TYPES.has(itemType)) {
      pushUnique(into.customerParts, text);
    } else if (RESPONSE_ITEM_TYPES.has(itemType)) {
      pushUnique(into.responseParts, text);
    } else if (text) {
      pushUnique(into.miscParts, text);
    }
  }
}

/**
 * @returns {{
 *   summary: string,
 *   response: string,
 *   allText: string,
 *   itemTypes: string[],
 *   utteranceType: string|null,
 * }}
 */
function extractActivityFields(activity) {
  const into = {
    customerParts: [],
    responseParts: [],
    miscParts: [],
    allParts: [],
    itemTypes: new Set(),
  };

  collectFromConversionDetails(activity?.conversionDetails, into);
  collectFromRecordItems(activity?.data?.voiceHistoryRecordItems, into);
  collectFromRecordItems(activity?.voiceHistoryRecordItems, into);

  const libSummary = normalizeText(activity?.description?.summary);
  if (libSummary) {
    pushUnique(into.customerParts, libSummary);
    pushUnique(into.allParts, libSummary);
  }

  const libResponse = extractSpokenResponse(activity);
  if (libResponse) {
    pushUnique(into.responseParts, libResponse);
    pushUnique(into.allParts, libResponse);
  }

  // Customer ASR first; otherwise non-response misc (routine/card text). Never
  // promote Alexa TTS into summary — response-only weather/timer fallbacks
  // key off an empty summary.
  const summary = into.customerParts.join(', ')
    || into.miscParts.join(', ')
    || '';
  const response = into.responseParts.join(', ') || libResponse || '';
  const miscText = into.miscParts.join(', ');
  const allText = [
    ...into.customerParts,
    ...into.miscParts,
    ...into.responseParts,
  ].join(' | ');

  return {
    summary: normalizeText(summary),
    response: normalizeText(response),
    miscText: normalizeText(miscText),
    allText: normalizeText(allText),
    itemTypes: [...into.itemTypes].sort(),
    utteranceType: activity?.data?.utteranceType || activity?.utteranceType || null,
  };
}

const SENT_TO_DISPLAY_RE = /\bsent\s+to\s+(?:your\s+)?display\b/i;

function isSentToDisplayResponse(text) {
  return SENT_TO_DISPLAY_RE.test(normalizeText(text));
}

module.exports = {
  extractActivityFields,
  isSentToDisplayResponse,
  SENT_TO_DISPLAY_RE,
  CUSTOMER_ITEM_TYPES,
  RESPONSE_ITEM_TYPES,
};
