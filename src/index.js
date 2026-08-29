const { installAuthProxyPatch } = require('./auth-proxy-patch');

// Must run before alexa-remote2 / alexa-cookie2 load the stock proxy so the
// control web page can start the login proxy in-process later.
installAuthProxyPatch();

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createListener } = require('./listener');
const { createWebServer } = require('./web-server');
const { createGuestSnapsAuth } = require('./guest-snaps-auth');
const { createLocaleSettings } = require('./locale-settings');
const { installRefreshPatch } = require('./auth-refresh-patch');
const { createVestaboardSimulator } = require('./vestaboard/simulator');
const { createVestaboardHub } = require('./vestaboard');

function registerShutdown(log) {
  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', error?.stack || error?.message || error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', reason?.stack || reason?.message || reason);
  });
}

function isAuthError(error) {
  const message = String(error?.message || error);
  return (
    message.includes('Please open http://')
    || message.includes('Login unsuccessfull')
    || message.includes('no csrf found')
    || message.includes('Authentication')
    || message.includes('authentication invalid')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config);
  installRefreshPatch({ log });
  const guestSnapsAuth = createGuestSnapsAuth(config, log);
  const localeSettings = createLocaleSettings(config, log);

  // The stand-in board comes up first so the hub can adopt it, and the hub
  // before the listener so its boards are in the registry from the first
  // picker request rather than appearing a moment later.
  let vestaboardSimulator = null;
  if (config.vestaboardSimulator?.enabled) {
    vestaboardSimulator = createVestaboardSimulator({ config, log });
    try {
      await vestaboardSimulator.start();
    } catch (error) {
      // A development aid must never take the bridge down over a busy port.
      log.error('Vestaboard simulator unavailable', error?.message || error);
      vestaboardSimulator = null;
    }
  }

  const vestaboardHub = createVestaboardHub({ config, log, simulator: vestaboardSimulator });
  try {
    await vestaboardHub.start();
  } catch (error) {
    log.error('Vestaboard boards unavailable', error?.message || error);
  }

  const listener = createListener({
    config, log, guestSnapsAuth, vestaboardHub, localeSettings,
  });

  registerShutdown(log);

  log.info('Signal Bridge starting');
  log.info('Running in foreground debug mode');

  try {
    await listener.start();

    const webServer = createWebServer({
      vestaboardSimulator,
      vestaboardHub,
      config,
      log,
      sendUdpPayload: listener.sendUdpPayload,
      recordVoiceEvent: listener.recordVoiceEvent,
      displayRegistry: listener.displayRegistry,
      deliverTargetedPayload: listener.deliverTargetedPayload,
      requestTimerPoll: listener.requestTimerPoll,
      requestAlarmPoll: listener.requestAlarmPoll,
      recordSteamPresence: listener.recordSteamPresence,
      getSteamStatus: listener.getSteamStatus,
      steamNowPlaying: listener.steamNowPlaying,
      getPsnStatus: listener.getPsnStatus,
      psnNowPlaying: listener.psnNowPlaying,
      getYoutubeStatus: listener.getYoutubeStatus,
      youtubeNowPlaying: listener.youtubeNowPlaying,
      getPlexStatus: listener.getPlexStatus,
      plexNowPlaying: listener.plexNowPlaying,
      autodarts: listener.autodarts,
      getAutodartsStatus: listener.getAutodartsStatus,
      huupe: listener.huupe,
      getHuupeStatus: listener.getHuupeStatus,
      trivia: listener.trivia,
      getTriviaStatus: listener.getTriviaStatus,
      upsideNews: listener.upsideNews,
      getUpsideNewsStatus: listener.getUpsideNewsStatus,
      wikiCommonKnowledge: listener.wikiCommonKnowledge,
      getWikiCommonKnowledgeStatus: listener.getWikiCommonKnowledgeStatus,
      overhead: listener.overhead,
      getOverheadStatus: listener.getOverheadStatus,
      flightplan: listener.flightplan,
      getFlightplanStatus: listener.getFlightplanStatus,
      displayBusy: listener.displayBusy,
      libraryTourSettings: listener.libraryTourSettings(),
      steamLibraryTour: listener.steamLibraryTour,
      psnLibraryTour: listener.psnLibraryTour,
      getSteamLibraryCount: listener.getSteamLibraryCount,
      getPsnLibraryCount: listener.getPsnLibraryCount,
      guestSnapsAuth,
      localeSettings,
    });
    webServer.start().catch((error) => {
      // The control page is a convenience — never take the listener down
      // because its port is busy.
      log.error('Control web server unavailable', error?.message || error);
    });
  } catch (error) {
    if (isAuthError(error)) {
      log.error('Amazon session expired or invalid');
      log.error('Stop the listener and re-authenticate:');
      log.error('  docker compose down');
      log.error('  PROXY_OWN_IP=YOUR_NAS_IP docker compose -f docker-compose.auth.yml up');
      log.error('  Open http://YOUR_NAS_IP:3456/ in your browser, log in, then Ctrl+C');
      log.error('  docker compose up -d');
      log.error('Waiting 1 hour before exit to avoid restart loop...');
      await sleep(60 * 60 * 1000);
    } else {
      log.error('Failed to start listener', error.message || error);
    }
    process.exit(1);
  }
}

main();
