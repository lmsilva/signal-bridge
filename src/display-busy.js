/**
 * Is the display showing something right now? (display-scheduler.md §6)
 *
 * The bridge never had this concept. Precedence was emergent: every page just
 * overwrote the last one, and `shouldSuppressNowPlayingForPayload` in
 * `listener.js` handled the one case anybody had hit. The Display Scheduler is
 * the lowest-priority page source in the system, so it needs an explicit answer
 * to "may I take the display?" — and the answer has to stay true for the whole
 * of a variable-duration sequence, not just the card currently on screen.
 *
 * Fed by every `sendUdpPayload`, so it needs no cooperation from callers.
 */

// Payload types that are commands or telemetry, not pages.
const NON_PAGE_TYPES = new Set([
  'display.announce',
  'display.discover',
  'display.heartbeat',
  'bridge.hello',
  'input.click',
  'input.key',
  'input.text',
  'system.command',
]);

/** Types that end a session rather than start one. */
const CLOSE_SUFFIX = '.close';

/**
 * Pages the scheduler itself is not allowed to interrupt even after their
 * countdown, because a person or an event put them there (§6 tiers 1–3).
 */
const PERSISTENT_HOLD_SECONDS = 15 * 60;

function createDisplayBusy({ now = () => Date.now(), log = null } = {}) {
  /** @type {{type: string, until: number|null, since: number, source: string}|null} */
  let current = null;
  // Increments on every page send so a slow command (air-quality enrich,
  // Tesla wake) can tell whether a *newer* page already replaced it.
  let generation = 0;

  function isPage(payload) {
    const type = String(payload?.type || '');
    if (!type || NON_PAGE_TYPES.has(type)) {
      return false;
    }
    return !type.endsWith(CLOSE_SUFFIX);
  }

  /**
   * @param {Object} payload  The UDP payload about to go out.
   * @param {Object} [options]
   * @param {number} [options.holdSeconds] Override — used for variable-duration
   *   sequences whose on-wire `displaySeconds` understates the real hold.
   * @param {string} [options.source] `manual` | `scheduler` | `event`.
   */
  function noteSent(payload, { holdSeconds = null, source = 'event' } = {}) {
    const type = String(payload?.type || '');
    if (type.endsWith(CLOSE_SUFFIX)) {
      // An explicit close frees the display immediately.
      if (current && current.type === type.slice(0, -CLOSE_SUFFIX.length)) {
        current = null;
      }
      return current;
    }
    if (!isPage(payload)) {
      return current;
    }

    const at = now();
    let seconds = Number(holdSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      seconds = Number(payload?.displaySeconds);
    }
    // `displaySeconds: 0` plus `persistent` means "stay until closed". Treat it
    // as a long hold rather than forever, so a client that dies without sending
    // a close cannot wedge the scheduler off the display permanently.
    const persistent = payload?.persistent === true || !(seconds > 0);
    generation += 1;
    current = {
      type,
      source,
      since: at,
      until: persistent ? at + PERSISTENT_HOLD_SECONDS * 1000 : at + seconds * 1000,
      persistent,
    };
    log?.debug?.(`display busy: ${type} for ${persistent ? 'until closed' : `${seconds}s`}`);
    return current;
  }

  function pageGeneration() {
    return generation;
  }

  /**
   * Gate late refreshes of one command. A cached preview may update itself;
   * a newer page from another command must not be overwritten when the first
   * command's fetch finally lands (admin AQ → Steam → stale AQ refresh).
   */
  function beginSendRequest() {
    const baseline = generation;
    let lastSent = null;
    return {
      maySend() {
        if (lastSent != null) {
          return generation === lastSent;
        }
        return generation === baseline;
      },
      rememberSent() {
        lastSent = generation;
      },
    };
  }

  /** §6: true for manual pushes, interrupts, live events, and any page still
   *  counting down its "Dismisses in Xs". Never interrupt a page mid-dismiss. */
  function isBusy() {
    if (!current) {
      return false;
    }
    if (current.until != null && now() >= current.until) {
      current = null;
      return false;
    }
    return true;
  }

  function snapshot() {
    const busy = isBusy();
    return {
      busy,
      type: busy ? current.type : null,
      source: busy ? current.source : null,
      since: busy ? new Date(current.since).toISOString() : null,
      until: busy && current.until ? new Date(current.until).toISOString() : null,
      remainingSeconds: busy && current.until
        ? Math.max(0, Math.round((current.until - now()) / 1000))
        : 0,
    };
  }

  function release() {
    current = null;
  }

  return { noteSent, isBusy, snapshot, release, pageGeneration, beginSendRequest };
}

module.exports = {
  NON_PAGE_TYPES,
  PERSISTENT_HOLD_SECONDS,
  createDisplayBusy,
};
