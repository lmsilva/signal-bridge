/**
 * Pure parsers for the Huupe Mini logcat stream.
 *
 * Everything here is side-effect free so the whole surface can be exercised
 * against the real captures in test/fixtures/huupe/ without a hoop on the LAN.
 * The collector in huupe-adb.js owns the process and the socket; this module
 * only ever sees strings.
 *
 * Two producers put shots on the wire. The system HAL
 * (huupe.hardware.shottracker-tof-service) emits every shot regardless of which
 * app is in front, prefixed RDM: (radar) or TOF: (time-of-flight). The Huupe app
 * re-logs the same shot under the ShotTracker tag as "Get EVENT:", twice. So one
 * physical shot arrives three or four times and dedupe is mandatory, not a
 * refinement — see dedupe notes on shotStreamKey.
 */

// Two logcat layouts, because the recon captures used both and threadtime is
// logcat's own default. The year group is optional so the same parser reads the
// captures (no year) and production, which adds `-v year` to keep archive
// timestamps unambiguous across a year boundary.
//
// `-v time`:       08-27 01:25:40.783 I/ShotTracker( 2736): Get EVENT: {...}
const TIME_LINE_RE =
  /^(?:(\d{4})-)?(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+([VDIWEF])\/(.+?)\(\s*(\d+)\):\s?(.*)$/;
// `-v threadtime`: 08-27 01:25:40.783  2736  2736 I ShotTracker: Get EVENT: {...}
const THREADTIME_LINE_RE =
  /^(?:(\d{4})-)?(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+\d+\s+([VDIWEF])\s+(.+?):\s?(.*)$/;

// The HAL and the app both wrap the same shot JSON in a different prefix.
const SHOT_RE = /^(?:RDM|TOF|Get EVENT):\s*(\{.*\})\s*$/;

// The device writes a trailing period ("startProcessing: started.") which an
// anchored match without it silently drops. Confirmed from a real Family Mode
// capture; it also arrives at D level on the ShotTracker tag, not Unity.
const PROCESSING_RE = /^startProcessing:\s*(started|paused)\.?\s*$/i;

// Unity's own final-scoreboard screen. A far cleaner "game is over" trigger
// than waiting on the stats upload, which can fail or be truncated.
const FINAL_SCREEN_RE = /^MRScreen_GameStatistics:Show\(\)/;
const STANDINGS_RE = /^(.+?) has scored (-?\d+(?:\.\d+)?) points and got (\d+) Position\s*$/;
const SCORED_RE = /^(.+?) scored (-?\d+(?:\.\d+)?)\s*$/;
const SHOT_MADE_RE = /^Did (.+?) Score From (\S+) SHOT MADE = (True|False)\s*$/i;

// Foreground detection. Unvalidated against a real capture (the recon folder has
// no ActivityTaskManager lines at all), so it is deliberately never load-bearing:
// a session opens on the first shot and the package is only a label.
const FOCUS_START_RE = /\bcmp=([A-Za-z0-9_.]+)\//;
const FOCUS_DISPLAYED_RE = /^Displayed ([A-Za-z0-9_.]+)\//;
const DEEP_LINK_RE = /\b((?:unitydl|huupe):\/\/\S+)/;

/**
 * Chatter that repeats forever on tags we subscribe to. Dropped by name rather
 * than left to fall through, because the unmatched ring buffer is the admin
 * troubleshooting tail and FPS lines every 10s would bury anything useful in it.
 */
const NOISE_RE = new RegExp(
  [
    '^Queues \\[',
    '^FPS \\[',
    '^type=\\d+ audit\\(',
    'avc: denied',
    'concurrent copying GC freed',
    'signal interference detected!',
  ].join('|'),
);

/**
 * Tags that dump the signed-in profile to logcat in plaintext.
 *
 * Verified on the device: every launcher profile sync writes email, password
 * hash and salt, home IP, city, postcode, GPS coordinates, date of birth and
 * the Stripe customer id at I/V level. The collector's `-s` allowlist means
 * these never arrive, but the unmatched buffer is rendered in the admin UI and
 * the replay harness can be aimed at an unfiltered capture, so they are dropped
 * outright rather than trusted to stay out of range.
 */
const SENSITIVE_TAG_RE = /^(?:OKPRFL|okhttp|handleRepositoryFlowResponse|Retrofit)/i;

const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

const REDACTIONS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, '[email]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]'],
  [
    /\b(password|passwordHash|passwordSalt|token|accessToken|refreshToken|secret|authorization|customerId|dob|ipPostalCode|ipLongituteLatitude)\b(["']?\s*[:=]\s*["']?)([^"',}\s)]+)/gi,
    (_match, key, sep) => `${key}${sep}[redacted]`,
  ],
];

/** Truncated so a 2 KB profile blob cannot dominate the admin tail. */
const MAX_BUFFERED_MESSAGE = 300;

/**
 * Best-effort scrub for anything held in memory and shown to a browser.
 *
 * This is a backstop, not the primary control — the tag allowlist is. It exists
 * because a leak here would surface real credentials in the admin page.
 */
function redactSensitive(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  // Public addresses only: LAN addresses are useful when debugging the hoop.
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) =>
    PRIVATE_IP_RE.test(ip) ? ip : '[ip]',
  );
  if (out.length > MAX_BUFFERED_MESSAGE) {
    out = `${out.slice(0, MAX_BUFFERED_MESSAGE)}...[truncated]`;
  }
  return out;
}

const TAG_HAL = 'huupe.hardware.shottracker-tof-service';
const TAG_APP = 'ShotTracker';
const TAG_SENSOR_ERROR = 'ShotTrackerErrorEvent';
const TAG_ACTIVITY = 'ActivityTaskManager';
const TAG_UNITY = 'Unity';

const LOGCAT_TAGS = [TAG_APP, TAG_SENSOR_ERROR, TAG_HAL, TAG_ACTIVITY, TAG_UNITY];

/**
 * What a made shot is worth in Family Mode, keyed by canonical zone.
 *
 * Family Mode states these itself: pairing each "{name} scored {N}" with the
 * "Did {name} Score From {zone}" that follows, then reconciling against the
 * end-of-game stats block, gives topOfTheKey 3, highPost 2, lowPost 1 and layup
 * 0.1 — summing to the 17.1 shown on the hoop.
 */
const ZONE_POINTS = { layup: 0.1, one: 1, two: 2, three: 3 };

/**
 * What a made shot is worth everywhere else, where the hardware tracker scores.
 *
 * Free play reports no points, but the HAL's own zone names carry the value
 * (`three_point_shot` and so on), so the same table produces a running session
 * score rather than one being invented. The rim is the exception: free play's
 * scoreboard has only 1pt / 2pt / 3pt counters and a drop-in from under the
 * basket ticks the 1pt one, so a layup is a one-pointer here. Scoring it as
 * Family Mode's 0.1 left the board 0.9 short of the hoop for every layup.
 */
const HAL_ZONE_POINTS = { ...ZONE_POINTS, layup: 1 };

const POINT_TABLES = { unity: ZONE_POINTS, hal: HAL_ZONE_POINTS };

/** HAL zone names are the proven ones, so they are canonical for stats. */
const HAL_ZONES = {
  layup: 'layup',
  one_point_shot: 'one',
  two_point_shot: 'two',
  three_point_shot: 'three',
};

/** Family Mode's Unity zones, mapped onto the same canonical names. */
const UNITY_ZONES = {
  layup: 'layup',
  lowPost: 'one',
  highPost: 'two',
  topOfTheKey: 'three',
};

/**
 * Points a made shot from this zone is worth; null for a zone we have not seen.
 *
 * `source` says which scoreboard is doing the counting — `unity` for Family
 * Mode, `hal` for the hardware tracker that scores every other mode.
 */
function pointsForZone(zone, source = 'unity') {
  const table = POINT_TABLES[source] || ZONE_POINTS;
  return zone && zone in table ? table[zone] : null;
}

/**
 * Family Mode is scored by Unity, which is the only source that knows whose
 * shot it was. Every other mode — free play included — is scored from the
 * hardware tracker's zones.
 */
function pointsTableForMode(mode) {
  return String(mode || '') === 'family' ? ZONE_POINTS : HAL_ZONE_POINTS;
}

const HUUPE_PACKAGES = {
  'com.game.huupecityroyale': 'family',
  'com.huupe.justhuupe': 'justhuupe',
  'com.game.huupedailyprize': 'dailyprize',
  'com.game.huupeminifitness': 'fitness',
  'com.huupe.huupelive': 'live',
  'com.acdetorres.huuplauncher': 'launcher',
};

function modeForPackage(pkg) {
  return HUUPE_PACKAGES[pkg] || null;
}

/**
 * Split a logcat line into its prefix fields and message.
 *
 * Returns null for anything that is not a logcat line at all, which covers the
 * `=== MONITORING STARTED ===` banners the recon script interleaved into the
 * captures as well as partial lines from a truncated stream.
 */
function parseLogLine(line, { year = null } = {}) {
  const text = String(line ?? '').trimEnd();

  let lineYear;
  let month;
  let day;
  let hour;
  let minute;
  let second;
  let millis;
  let level;
  let tag;
  let pid;
  let message;

  const timeMatch = TIME_LINE_RE.exec(text);
  if (timeMatch) {
    [, lineYear, month, day, hour, minute, second, millis, level, tag, pid, message] = timeMatch;
  } else {
    const threadMatch = THREADTIME_LINE_RE.exec(text);
    if (!threadMatch) return null;
    // threadtime orders pid before the level and drops the parentheses.
    [, lineYear, month, day, hour, minute, second, millis, pid, level, tag, message] = threadMatch;
  }

  const resolvedYear = lineYear || (year == null ? null : String(year));
  return {
    // Device-local wall clock with no offset attached. logcat reports the
    // device's local time and the parser has no way to know its zone, so the
    // collector stamps the offset it read from the device.
    deviceTime: resolvedYear
      ? `${resolvedYear}-${month}-${day}T${hour}:${minute}:${second}.${millis}`
      : null,
    month,
    day,
    clock: `${hour}:${minute}:${second}.${millis}`,
    level,
    tag: tag.trim(),
    pid: Number(pid),
    message,
  };
}

/**
 * Dedupe key for a shot.
 *
 * Must be the parsed float, never the raw substring: the HAL prints
 * `622.501160` where other producers print `622.50116`, and a string key would
 * score that as two separate shots.
 */
function shotStreamKey(streamTs) {
  const value = Number(streamTs);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pull the shot payload out of an RDM:/TOF:/Get EVENT: message.
 *
 * Interference reports ride the same channel with an empty zone and a -1 range;
 * they are not shots and are reported separately so the admin card can surface
 * a noisy sensor without them ever reaching the scoreboard.
 */
function parseShotMessage(message) {
  const match = SHOT_RE.exec(message);
  if (!match) return null;

  let json;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const events = Array.isArray(json.events) ? json.events : [];
  const streamTs = shotStreamKey(json.stream_ts);
  if (streamTs == null) return null;

  if (events.includes('signal_interference_detected')) {
    return { kind: 'interference', streamTs };
  }

  const made = events.includes('make_detected');
  const missed = events.includes('miss_detected');
  if (!made && !missed) return null;

  const rawZone = typeof json.shot_zone === 'string' ? json.shot_zone : '';
  const zone = HAL_ZONES[rawZone] || null;
  const range = Number(json.shot_range);
  return {
    kind: 'shot',
    streamTs,
    made,
    rawZone,
    zone,
    // What the zone is worth if made — callers add it only when `made` is true.
    points: pointsForZone(zone, 'hal'),
    // -1 is the sentinel the HAL uses when it has no range fix.
    range: Number.isFinite(range) && range >= 0 ? range : null,
  };
}

/**
 * Family Mode / City Royale Unity strings.
 *
 * Transcribed from the spec rather than a capture — the referenced filtered.log
 * is not in the research folder and no Family Mode lines appear anywhere in it.
 * Anything these miss lands in the unmatched buffer, which is how the first real
 * game will tell us what to correct.
 */
function parseFamilyMessage(message) {
  const processing = PROCESSING_RE.exec(message);
  if (processing) {
    return { kind: 'processing', state: processing[1].toLowerCase() };
  }

  // Checked before the bare "scored" form, which would otherwise swallow the
  // standings line and read the player name as "Jo has".
  const standings = STANDINGS_RE.exec(message);
  if (standings) {
    return {
      kind: 'standings',
      player: standings[1].trim(),
      points: Number(standings[2]),
      // Position 0 is the winner.
      position: Number(standings[3]),
    };
  }

  if (FINAL_SCREEN_RE.test(message)) {
    return { kind: 'final-screen' };
  }

  const shotMade = SHOT_MADE_RE.exec(message);
  if (shotMade) {
    const unityZone = shotMade[2];
    const zone = UNITY_ZONES[unityZone] || null;
    return {
      kind: 'shot-made',
      player: shotMade[1].trim(),
      unityZone,
      zone,
      points: pointsForZone(zone),
      made: shotMade[3].toLowerCase() === 'true',
    };
  }

  const scored = SCORED_RE.exec(message);
  if (scored) {
    return { kind: 'scored', player: scored[1].trim(), points: Number(scored[2]) };
  }

  return null;
}

/**
 * Pull one balanced `"key":{...}` object out of a possibly-truncated string.
 *
 * Brace-walking rather than a regex because the fragment has to stay valid JSON
 * on its own; if the string is cut before the object closes we give up on that
 * key instead of returning something half-parsed.
 */
function extractJsonObject(text, key) {
  const marker = `"${key}":{`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = start + marker.length - 1;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === '{') {
      depth += 1;
    } else if (!inString && char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The end-of-game stats upload for the signed-in profile.
 *
 * Real captures show two things the spec's tidied example hides. The payload is
 * nested under `data`, not at the top level, and logcat cuts the line off
 * mid-token — the observed blob ended inside `profileId` with unbalanced braces,
 * and the following lines are Unity stack frames rather than a continuation. So
 * a whole-string JSON.parse is the exception, not the rule, and the fallback
 * recovers the identity and stats fragments that did survive.
 *
 * This is only ever supplementary: it covers the logged-in profile alone, while
 * the scoreboard is built from the per-shot Unity lines, which cover everyone.
 */
function parseEndGameMessage(message) {
  if (!message.includes('uniqueScoreId')) return null;

  const start = message.indexOf('{');
  if (start < 0) return null;
  const body = message.slice(start);

  let truncated = false;
  let node = null;
  try {
    const whole = JSON.parse(body);
    node = whole && typeof whole === 'object' ? whole.data || whole : null;
  } catch {
    truncated = true;
  }

  if (!node) {
    const id = /"uniqueScoreId"\s*:\s*"([^"]+)"/.exec(body);
    if (!id) return null;
    return {
      kind: 'game-end',
      uniqueScoreId: id[1],
      combination: extractJsonObject(body, 'combination'),
      stats: extractJsonObject(body, 'stats'),
      truncated,
    };
  }

  if (typeof node.uniqueScoreId !== 'string') return null;
  return {
    kind: 'game-end',
    uniqueScoreId: node.uniqueScoreId,
    combination: node.combination || null,
    stats: node.stats || null,
    truncated,
  };
}

function parseFocusMessage(message) {
  const displayed = FOCUS_DISPLAYED_RE.exec(message);
  const started = displayed ? null : FOCUS_START_RE.exec(message);
  const pkg = displayed ? displayed[1] : started ? started[1] : null;
  if (!pkg) return null;
  const mode = modeForPackage(pkg);
  if (!mode) return null;
  const deepLink = DEEP_LINK_RE.exec(message);
  return {
    kind: 'focus',
    package: pkg,
    mode,
    // City Royale's launch URL carries a bearer JWT in a `token=` query param,
    // so the link is scrubbed before it can reach a log line or the admin page.
    deepLink: deepLink ? redactSensitive(deepLink[1]) : null,
  };
}

/**
 * Stateful wrapper over the pure parsers: shot dedupe, counters and the ring
 * buffer of unmatched lines that backs the admin troubleshooting tail.
 */
function createHuupeParser({ unmatchedLimit = 200, dedupeWindow = 512, year = null } = {}) {
  let unmatched = [];
  let seen = [];
  let seenSet = new Set();
  let lastStreamTs = null;
  const counters = {
    lines: 0,
    events: 0,
    noise: 0,
    unmatched: 0,
    duplicateShots: 0,
    interference: 0,
    sensorErrors: 0,
    redacted: 0,
  };

  function resetDedupe() {
    seen = [];
    seenSet = new Set();
    lastStreamTs = null;
  }

  function isDuplicateShot(streamTs) {
    // stream_ts counts seconds since the HAL started, so it rewinds whenever the
    // service restarts. Treating that as a duplicate would silently drop every
    // shot of the next session, so a rewind clears the window instead.
    if (lastStreamTs != null && streamTs < lastStreamTs - 1) resetDedupe();
    lastStreamTs = streamTs;

    if (seenSet.has(streamTs)) return true;
    seenSet.add(streamTs);
    seen.push(streamTs);
    if (seen.length > dedupeWindow) seenSet.delete(seen.shift());
    return false;
  }

  function recordUnmatched(entry) {
    counters.unmatched += 1;
    if (SENSITIVE_TAG_RE.test(entry.tag)) {
      counters.redacted += 1;
      return;
    }
    unmatched.push({ ...entry, message: redactSensitive(entry.message) });
    if (unmatched.length > unmatchedLimit) unmatched.shift();
  }

  /**
   * Turn one raw logcat line into at most one event.
   *
   * Returns null for noise, duplicates and lines we do not understand; the
   * caller can treat null as "nothing happened".
   */
  function parse(rawLine) {
    counters.lines += 1;
    const line = parseLogLine(rawLine, { year });
    if (!line) return null;

    if (NOISE_RE.test(line.message)) {
      counters.noise += 1;
      return null;
    }

    const at = line.deviceTime;
    const base = { at, tag: line.tag, pid: line.pid };

    if (line.tag === TAG_SENSOR_ERROR) {
      counters.sensorErrors += 1;
      counters.events += 1;
      return { ...base, kind: 'sensor-error', message: line.message };
    }

    if (line.tag === TAG_HAL || line.tag === TAG_APP) {
      const shot = parseShotMessage(line.message);
      if (shot) {
        if (shot.kind === 'interference') {
          counters.interference += 1;
          return null;
        }
        if (isDuplicateShot(shot.streamTs)) {
          counters.duplicateShots += 1;
          return null;
        }
        counters.events += 1;
        return { ...base, ...shot };
      }
    }

    if (line.tag === TAG_APP || line.tag === TAG_UNITY) {
      const ended = parseEndGameMessage(line.message);
      if (ended) {
        counters.events += 1;
        return { ...base, ...ended };
      }
      const family = parseFamilyMessage(line.message);
      if (family) {
        counters.events += 1;
        return { ...base, ...family };
      }
    }

    if (line.tag === TAG_ACTIVITY) {
      const focus = parseFocusMessage(line.message);
      if (focus) {
        counters.events += 1;
        return { ...base, ...focus };
      }
      // Activity churn for non-Huupe packages is expected and uninteresting.
      return null;
    }

    recordUnmatched({ at, tag: line.tag, message: line.message });
    return null;
  }

  return {
    parse,
    reset() {
      resetDedupe();
      unmatched = [];
      for (const key of Object.keys(counters)) counters[key] = 0;
    },
    counters: () => ({ ...counters }),
    unmatched: () => unmatched.slice(),
  };
}

module.exports = {
  createHuupeParser,
  parseLogLine,
  parseShotMessage,
  parseFamilyMessage,
  parseEndGameMessage,
  parseFocusMessage,
  shotStreamKey,
  modeForPackage,
  redactSensitive,
  SENSITIVE_TAG_RE,
  extractJsonObject,
  pointsForZone,
  pointsTableForMode,
  LOGCAT_TAGS,
  HAL_ZONES,
  UNITY_ZONES,
  ZONE_POINTS,
  HAL_ZONE_POINTS,
  HUUPE_PACKAGES,
};
