const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadYoutubeApiKey,
  saveYoutubeApiKey,
  resolveYoutubeApiKey,
} = require('../src/youtube-credentials');
const { resolveYoutubeConfig } = require('../src/youtube-config');

describe('youtube credentials persistence', () => {
  let dir;
  let credentialsPath;
  const previousEnv = process.env.YOUTUBE_API_KEY;
  const previousSecret = process.env.SIGNAL_SECRET_KEY;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-creds-'));
    credentialsPath = path.join(dir, 'youtube-credentials.json');
    delete process.env.YOUTUBE_API_KEY;
    process.env.SIGNAL_SECRET_KEY = 'test-youtube-credentials-secret-key';
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env.YOUTUBE_API_KEY;
    } else {
      process.env.YOUTUBE_API_KEY = previousEnv;
    }
    if (previousSecret === undefined) {
      delete process.env.SIGNAL_SECRET_KEY;
    } else {
      process.env.SIGNAL_SECRET_KEY = previousSecret;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saves an encrypted key and reloads it after a simulated restart', () => {
    saveYoutubeApiKey(credentialsPath, 'AIzaSyTestKey1234567890');
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    assert.notEqual(raw.apiKey, 'AIzaSyTestKey1234567890');
    assert.match(String(raw.apiKey), /^v1:/);

    const reloaded = loadYoutubeApiKey(credentialsPath);
    assert.equal(reloaded, 'AIzaSyTestKey1234567890');

    const resolved = resolveYoutubeApiKey({ credentialsPath, env: {} });
    assert.equal(resolved.apiKey, 'AIzaSyTestKey1234567890');
    assert.equal(resolved.apiKeySource, 'session');
  });

  it('lets YOUTUBE_API_KEY env win over the credentials file', () => {
    saveYoutubeApiKey(credentialsPath, 'session-key');
    const resolved = resolveYoutubeApiKey({
      credentialsPath,
      env: { YOUTUBE_API_KEY: 'env-key' },
    });
    assert.equal(resolved.apiKey, 'env-key');
    assert.equal(resolved.apiKeySource, 'env');
  });

  it('resolveYoutubeConfig loads the session key when env is empty', () => {
    saveYoutubeApiKey(credentialsPath, 'config-session-key');
    const youtube = resolveYoutubeConfig(
      { ROOT: dir },
      { youtube: { credentialsFile: 'youtube-credentials.json' } },
    );
    assert.equal(youtube.apiKey, 'config-session-key');
    assert.equal(youtube.apiKeySource, 'session');
    assert.equal(youtube.credentialsPath, credentialsPath);
  });
});
