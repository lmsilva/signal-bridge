/**
 * Detect Alexa reminder set / cancel / fire from history ASR and TTS.
 *
 * Reminders are a separate Amazon notification type (`Reminder`), not timers
 * or wake alarms. Setting one often leaves `description.summary` empty and
 * only stores the spoken confirmation (e.g. "I'll remind you to check on the
 * corn in one hour, at 11:46 AM."). Firing is Alexa-initiated TTS
 * ("Here's your reminder to check on the corn") and/or the Reminder row
 * dropping off `getNotifications`.
 */

const OFFER_RE =
  /\b(?:what time would you like me to remind you|would you like (?:me )?to remind you|want me to (?:set a )?remind(?:er)?|should i remind you)\b/i;

const SET_QUERY_RE =
  /\bremind me\b|\bset (?:a |an )?(?:reminder|alert)\b|\bcreate (?:a |an )?reminder\b|\badd (?:a |an )?reminder\b/i;

const SET_SPOKEN_RE =
  /\bi(?:'?ll| will) remind you\b|\breminder (?:is )?(?:set|scheduled)\b|\bok(?:ay)?,? (?:i(?:'?ve| have) )?set (?:a |your )?reminder\b/i;

const FIRE_SPOKEN_RE =
  /\bhere(?:'?s| is) your reminder\b|\bthis is (?:a |your )?reminder\b|\bit'?s time for your reminder\b|\byour reminder (?:to|for|:)\b/i;

const CANCEL_QUERY_RE =
  /\b(?:cancel|delete|remove|stop)(?:\s+(?:the|my|all|a|an))?(?:\s+\S+){0,5}\s+reminders?\b/i;

const CANCEL_SPOKEN_RE =
  /\b(?:cancel(?:l?ed|ling)?|remov(?:ed|ing)|delet(?:ed|ing))\b(?:(?![.!?]).){0,40}\breminders?\b|\breminders?\b(?:(?!\.).){0,40}\b(?:cancel(?:l?ed)?|removed|deleted)\b/i;

function spoken(summary, response) {
  return `${String(summary || '')} ${String(response || '')}`.trim();
}

function matchesReminderOffer(summary, response) {
  return OFFER_RE.test(spoken(summary, response));
}

function matchesReminderFiredSpeech(summary, response) {
  const text = spoken(summary, response);
  if (!text || matchesReminderOffer(summary, response)) {
    return false;
  }
  return FIRE_SPOKEN_RE.test(text);
}

function matchesReminderSetQuery(summary, response) {
  if (matchesReminderFiredSpeech(summary, response)) {
    return false;
  }
  if (matchesReminderOffer(summary, response)) {
    return false;
  }
  if (SET_QUERY_RE.test(String(summary || ''))) {
    return true;
  }
  return SET_SPOKEN_RE.test(String(response || ''));
}

function matchesReminderCancelQuery(summary, response) {
  if (CANCEL_QUERY_RE.test(String(summary || ''))) {
    return true;
  }
  return CANCEL_SPOKEN_RE.test(String(response || ''));
}

function stripTrailingSchedule(value) {
  return String(value || '')
    .replace(/[.,!?;:]+$/g, '')
    .replace(/,?\s+(?:in|at|for)\s+(?:about\s+)?(?:an?\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hour|minute|second|min|sec|hr)s?\b.*$/i, '')
    .replace(/,?\s+at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReminderLabel(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return null;
  }

  const patterns = [
    /\bi(?:'?ll| will) remind you to\s+(.+)$/i,
    /\bhere(?:'?s| is) your reminder(?: to|:)\s+(.+)$/i,
    /\bthis is (?:a |your )?reminder(?: to|:)\s+(.+)$/i,
    /\byour reminder (?:to|for|:)\s+(.+)$/i,
    /\bremind me to\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const label = stripTrailingSchedule(match[1]);
      if (label) {
        return label;
      }
    }
  }

  return null;
}

module.exports = {
  matchesReminderSetQuery,
  matchesReminderCancelQuery,
  matchesReminderFiredSpeech,
  matchesReminderOffer,
  extractReminderLabel,
};
