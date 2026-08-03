const path = require('path');
const { resolveYoutubeApiKey } = require('./youtube-credentials');

/**
 * Resolve the YouTube feature's config, following the `resolvePsnConfig` shape:
 * every tunable reads env → file config → default, and every on-disk artefact
 * is stored as both a relative `*File`/`*Dir` key and an absolute `*Path` key.
 */
function resolveYoutubeConfig(config, fileConfig = {}) {
  const youtube = fileConfig.youtube || config.youtube || {};
  const root = config.ROOT || path.resolve(__dirname, '..');

  const devicesRel = youtube.devicesFile || 'data/youtube-devices.json';
  const settingsRel = youtube.settingsFile || 'data/youtube-settings.json';
  const cacheRel = youtube.cacheFile || 'data/youtube-cache.json';
  const historyRel = youtube.historyFile || 'data/youtube-history.json';
  const thumbnailRel = youtube.thumbnailCacheDir || 'data/youtube-thumbnails';
  const credentialsRel = youtube.credentialsFile || 'data/youtube-credentials.json';
  const credentialsPath = path.resolve(root, credentialsRel);

  const resolved = resolveYoutubeApiKey({
    env: process.env,
    configKey: youtube.apiKey,
    credentialsPath,
  });

  return {
    enabled: youtube.enabled !== false && process.env.YOUTUBE_ENABLED !== '0',
    apiKey: resolved.apiKey,
    apiKeySource: resolved.apiKeySource,

    // The Lounge API is undocumented, so the sidecar is opt-out separately from
    // the rest of the feature: metadata, history and the last-played card all
    // keep working with detection switched off.
    loungeEnabled: youtube.loungeEnabled !== false && process.env.YOUTUBE_LOUNGE_ENABLED !== '0',
    pythonBin: String(process.env.YOUTUBE_PYTHON_BIN || youtube.pythonBin || 'python3'),
    agentScript: path.resolve(root, youtube.agentScript || 'src/youtube_lounge_agent.py'),

    devicesFile: devicesRel,
    devicesPath: path.resolve(root, devicesRel),
    settingsFile: settingsRel,
    settingsPath: path.resolve(root, settingsRel),
    cacheFile: cacheRel,
    cachePath: path.resolve(root, cacheRel),
    historyFile: historyRel,
    historyPath: path.resolve(root, historyRel),
    thumbnailCacheDir: thumbnailRel,
    thumbnailCachePath: path.resolve(root, thumbnailRel),
    credentialsFile: credentialsRel,
    credentialsPath,
  };
}

module.exports = {
  resolveYoutubeConfig,
};
