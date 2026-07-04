const fs = require('fs');
const path = require('path');
const Alexa = require('alexa-remote2');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { buildAlexaInitOptions, loadSession } = require('./session');
const { getIndoorLocations } = require('./indoor-locations');
const { getAirQualityMonitors } = require('./air-quality-locations');
const {
  isAirQualityEndpoint,
  isClimateEndpoint,
  listSmarthomeEndpoints,
  queryEndpointState,
  summarizeEndpoint,
} = require('./smarthome-devices');
const { mapDeviceReading } = require('./air-quality-fetch');

function writeJson(relativePath, data) {
  const target = path.join(process.cwd(), relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return target;
}

async function diagnoseIndoor() {
  const config = loadConfig();
  const log = createLogger({ ...config, debug: false });
  const session = loadSession(config.sessionPath);

  if (!session) {
    log.error('No session file', config.sessionPath);
    process.exit(1);
  }

  log.info('Configured thermostat locations', getIndoorLocations(config.indoorTemperature || {}));
  log.info('Configured air quality monitors', getAirQualityMonitors(config.airQuality || {}));

  const alexa = new Alexa();
  const initOptions = buildAlexaInitOptions(config, session);
  initOptions.logger = config.debug ? log.debug.bind(log) : () => {};

  await new Promise((resolve, reject) => {
    alexa.init(initOptions, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  log.info('Authentication OK');

  const endpoints = await listSmarthomeEndpoints(alexa);
  log.info(`Smart Home endpoints: ${endpoints.length}`);

  const airQualityEndpoints = endpoints.filter(isAirQualityEndpoint);
  const climateEndpoints = endpoints.filter(isClimateEndpoint);

  const airQualitySummary = airQualityEndpoints.map(summarizeEndpoint);
  const climateSummary = climateEndpoints.map(summarizeEndpoint);

  writeJson('data/diagnose-indoor-air-quality-monitors.json', airQualityEndpoints.map((entry) => entry.raw));
  writeJson('data/diagnose-indoor-air-quality-summary.json', airQualitySummary);
  writeJson('data/diagnose-indoor-climate-summary.json', climateSummary);

  log.info(`Air quality monitors: ${airQualitySummary.length}`);
  airQualitySummary.forEach((device, index) => {
    log.info(`AQM ${index + 1}`, device);
  });

  log.info(`Climate/thermostat endpoints: ${climateSummary.length}`);
  climateSummary.slice(0, 15).forEach((device, index) => {
    log.info(`Climate ${index + 1}`, device);
  });

  if (airQualityEndpoints.length && typeof alexa.querySmarthomeDevices === 'function') {
    log.info('Querying live state for air quality monitors...');
    for (const [index, endpoint] of airQualityEndpoints.entries()) {
      try {
        const state = await queryEndpointState(alexa, endpoint);
        const reading = mapDeviceReading({ ...endpoint.raw, ...state });
        log.info(`AQM query ${index + 1}`, {
          friendlyName: endpoint.friendlyName,
          entityId: endpoint.entityId,
          applianceId: endpoint.applianceId,
          reading,
          stateKeys: state ? Object.keys(state) : [],
        });
      } catch (error) {
        log.warn(`AQM query failed for ${endpoint.friendlyName}`, error.message || error);
      }
    }
  }

  log.info('Wrote data/diagnose-indoor-air-quality-summary.json');
  process.exit(0);
}

diagnoseIndoor().catch((error) => {
  console.error('Indoor diagnose failed:', error.message || error);
  console.error('Run: npm run auth');
  process.exit(1);
});
