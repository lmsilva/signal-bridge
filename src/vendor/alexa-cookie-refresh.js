/**
 * Patched cookie refresh flow for alexa-cookie2.
 *
 * The stock refreshAlexaCookie() ends by re-registering the app via
 * POST /auth/register. Amazon now rejects that call during refresh with
 * `InvalidToken / Auth time of the token is expired`, so every refresh
 * fails with "No tokens in Register response", tokenDate never rotates,
 * and the session dies after ~24-36h.
 *
 * Fix (upstream https://github.com/Apollon77/alexa-cookie/pull/191):
 * skip /auth/register during refresh. Keep the existing registration
 * (refreshToken, deviceSerial, macDms), exchange the refresh token for
 * fresh cookies, re-register capabilities with the new access token,
 * refresh marketplace cookies + CSRF, and advance tokenDate.
 */

const https = require('https');
const querystring = require('querystring');
const url = require('url');
const os = require('os');
const path = require('path');

function resolveCookieTools() {
  try {
    return require('cookie');
  } catch (error) {
    const base = path.dirname(require.resolve('alexa-cookie2'));
    return require(require.resolve('cookie', { paths: [base] }));
  }
}

const cookieTools = resolveCookieTools();

const defaultAmazonPage = 'amazon.de';
const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
const defaultUserAgentLinux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
const defaultAcceptLanguage = 'de-DE';
const defaultAppName = 'ioBroker Alexa2';

const apiCallVersion = '2.2.651540.0';
const apiCallUserAgent = 'AmazonWebView/Amazon Alexa/2.2.651540.0/iOS/18.3.1/iPhone';

const csrfOptions = [
  '/api/language',
  '/spa/index.html',
  '/api/devices-v2/device?cached=false',
  '/templates/oobe/d-device-pick.handlebars',
  '/api/strings',
];

const CAPABILITIES_BODY = '{"legacyFlags":{"SUPPORTS_COMMS":true,"SUPPORTS_ARBITRATION":true,"SCREEN_WIDTH":1170,"SUPPORTS_SCRUBBING":true,"SPEECH_SYNTH_SUPPORTS_TTS_URLS":false,"SUPPORTS_HOME_AUTOMATION":true,"SUPPORTS_DROPIN_OUTBOUND":true,"FRIENDLY_NAME_TEMPLATE":"VOX","SUPPORTS_SIP_OUTBOUND_CALLING":true,"VOICE_PROFILE_SWITCHING_DISABLED":true,"SUPPORTS_LYRICS_IN_CARD":false,"SUPPORTS_DATAMART_NAMESPACE":"Vox","SUPPORTS_VIDEO_CALLING":true,"SUPPORTS_PFM_CHANGED":true,"SUPPORTS_TARGET_PLATFORM":"TABLET","SUPPORTS_SECURE_LOCKSCREEN":false,"AUDIO_PLAYER_SUPPORTS_TTS_URLS":false,"SUPPORTS_KEYS_IN_HEADER":false,"SUPPORTS_MIXING_BEHAVIOR_FOR_AUDIO_PLAYER":false,"AXON_SUPPORT":true,"SUPPORTS_TTS_SPEECHMARKS":true},"envelopeVersion":"20160207","capabilities":[{"version":"0.1","interface":"CardRenderer","type":"AlexaInterface"},{"interface":"Navigation","type":"AlexaInterface","version":"1.1"},{"type":"AlexaInterface","version":"2.0","interface":"Alexa.Comms.PhoneCallController"},{"type":"AlexaInterface","version":"1.1","interface":"ExternalMediaPlayer"},{"type":"AlexaInterface","interface":"Alerts","configurations":{"maximumAlerts":{"timers":2,"overall":99,"alarms":2}},"version":"1.3"},{"version":"1.0","interface":"Alexa.Display.Window","type":"AlexaInterface","configurations":{"templates":[{"type":"STANDARD","id":"app_window_template","configuration":{"sizes":[{"id":"fullscreen","type":"DISCRETE","value":{"value":{"height":1440,"width":3200},"unit":"PIXEL"}}],"interactionModes":["mobile_mode","auto_mode"]}}]}},{"type":"AlexaInterface","interface":"AccessoryKit","version":"0.1"},{"type":"AlexaInterface","interface":"Alexa.AudioSignal.ActiveNoiseControl","version":"1.0","configurations":{"ambientSoundProcessingModes":[{"name":"ACTIVE_NOISE_CONTROL"},{"name":"PASSTHROUGH"}]}},{"interface":"PlaybackController","type":"AlexaInterface","version":"1.0"},{"version":"1.0","interface":"Speaker","type":"AlexaInterface"},{"version":"1.0","interface":"SpeechSynthesizer","type":"AlexaInterface"},{"version":"1.0","interface":"AudioActivityTracker","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Alexa.Camera.LiveViewController","version":"1.0"},{"type":"AlexaInterface","version":"1.0","interface":"Alexa.Input.Text"},{"type":"AlexaInterface","interface":"Alexa.PlaybackStateReporter","version":"1.0"},{"version":"1.1","interface":"Geolocation","type":"AlexaInterface"},{"interface":"Alexa.Health.Fitness","version":"1.0","type":"AlexaInterface"},{"interface":"Settings","type":"AlexaInterface","version":"1.0"},{"configurations":{"interactionModes":[{"dialog":"SUPPORTED","interactionDistance":{"value":18,"unit":"INCHES"},"video":"SUPPORTED","keyboard":"SUPPORTED","id":"mobile_mode","uiMode":"MOBILE","touch":"SUPPORTED"},{"video":"UNSUPPORTED","dialog":"SUPPORTED","interactionDistance":{"value":36,"unit":"INCHES"},"uiMode":"AUTO","touch":"SUPPORTED","id":"auto_mode","keyboard":"UNSUPPORTED"}]},"type":"AlexaInterface","interface":"Alexa.InteractionMode","version":"1.0"},{"type":"AlexaInterface","configurations":{"catalogs":[{"type":"IOS_APP_STORE","identifierTypes":["URI_HTTP_SCHEME","URI_CUSTOM_SCHEME"]}]},"version":"0.2","interface":"Alexa.Launcher"},{"interface":"System","version":"1.0","type":"AlexaInterface"},{"interface":"Alexa.IOComponents","type":"AlexaInterface","version":"1.4"},{"type":"AlexaInterface","interface":"Alexa.FavoritesController","version":"1.0"},{"version":"1.0","type":"AlexaInterface","interface":"Alexa.Mobile.Push"},{"type":"AlexaInterface","interface":"InteractionModel","version":"1.1"},{"interface":"Alexa.PlaylistController","type":"AlexaInterface","version":"1.0"},{"interface":"SpeechRecognizer","type":"AlexaInterface","version":"2.1"},{"interface":"AudioPlayer","type":"AlexaInterface","version":"1.3"},{"type":"AlexaInterface","version":"3.1","interface":"Alexa.RTCSessionController"},{"interface":"VisualActivityTracker","version":"1.1","type":"AlexaInterface"},{"interface":"Alexa.PlaybackController","version":"1.0","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Alexa.SeekController","version":"1.0"},{"interface":"Alexa.Comms.MessagingController","type":"AlexaInterface","version":"1.0"}]}';

function addCookies(existingCookie, headers) {
  if (!headers || !headers['set-cookie']) {
    return existingCookie || '';
  }
  const cookies = cookieTools.parse(existingCookie || '');
  for (let cookie of headers['set-cookie']) {
    cookie = cookie.match(/^([^=]+)=([^;]+);.*/);
    if (cookie && cookie.length === 3) {
      if (cookie[1] === 'ap-fid' && cookie[2] === '""') continue;
      cookies[cookie[1]] = cookie[2];
    }
  }
  let result = '';
  for (const name of Object.keys(cookies)) {
    result += `${name}=${cookies[name]}; `;
  }
  return result.replace(/[; ]*$/, '');
}

function defaultRequestFn(options, logger, callback) {
  logger && logger(`Alexa-Cookie-Refresh: Sending Request to ${options.host}${options.path}`);

  if (options.body && (!options.headers || !options.headers['Content-Length'])) {
    options.headers = options.headers || {};
    options.headers['Content-Length'] = Buffer.byteLength(options.body);
  }

  const req = https.request(options, (res) => {
    let body = '';

    if (options.followRedirects !== false && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      logger && logger(`Alexa-Cookie-Refresh: Response (${res.statusCode}) - Redirect to ${res.headers.location}`);
      const u = url.parse(res.headers.location);
      const nextOptions = { ...options };
      if (u.host) nextOptions.host = u.host;
      nextOptions.path = u.path;
      nextOptions.method = 'GET';
      nextOptions.body = '';
      nextOptions.headers = { ...options.headers };
      delete nextOptions.headers['Content-Length'];
      nextOptions.headers.Cookie = addCookies(nextOptions.headers.Cookie, res.headers);
      res.socket && res.socket.end();
      defaultRequestFn(nextOptions, logger, callback);
      return;
    }

    logger && logger(`Alexa-Cookie-Refresh: Response (${res.statusCode})`);
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      res.socket && res.socket.end();
      callback(null, res, body);
    });
  });

  req.on('error', (error) => callback(error, null, null));
  if (options.body) {
    req.write(options.body);
  }
  req.end();
}

function createAlexaCookieRefresh({ requestFn } = {}) {
  function normalizeConfig(options) {
    const config = {
      amazonPage: options.amazonPage || defaultAmazonPage,
      baseAmazonPage: options.baseAmazonPage || 'amazon.com',
      deviceAppName: options.deviceAppName || defaultAppName,
      acceptLanguage: options.acceptLanguage || defaultAcceptLanguage,
      userAgent: options.userAgent
        || (os.platform() === 'win32' ? defaultUserAgent : defaultUserAgentLinux),
      logger: options.logger,
    };
    if (options.formerRegistrationData && options.formerRegistrationData.amazonPage) {
      config.amazonPage = options.formerRegistrationData.amazonPage;
    }
    return config;
  }

  function send(options, config, callback) {
    (requestFn || ((opts, cb) => defaultRequestFn(opts, config.logger, cb)))(options, callback);
  }

  function getLocalCookies(config, amazonPage, refreshToken, callback) {
    const exchangeParams = {
      'di.os.name': 'iOS',
      'app_version': apiCallVersion,
      'domain': `.${amazonPage}`,
      'source_token': refreshToken,
      'requested_token_type': 'auth_cookies',
      'source_token_type': 'refresh_token',
      'di.hw.version': 'iPhone',
      'di.sdk.version': '6.12.4',
      'app_name': config.deviceAppName,
      'di.os.version': '16.6',
    };
    const options = {
      host: `www.${amazonPage}`,
      path: '/ap/exchangetoken/cookies',
      method: 'POST',
      headers: {
        'User-Agent': apiCallUserAgent,
        'Accept-Language': config.acceptLanguage,
        'Accept-Charset': 'utf-8',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'Cookie': '',
        'x-amzn-identity-auth-domain': `api.${amazonPage}`,
      },
      body: querystring.stringify(exchangeParams, null, null, { encodeURIComponent }),
    };

    config.logger && config.logger(`Alexa-Cookie-Refresh: Exchange tokens for ${amazonPage}`);
    send(options, config, (error, response, body) => {
      if (error) {
        callback(error, null);
        return;
      }
      try {
        if (typeof body !== 'object') body = JSON.parse(body);
      } catch (err) {
        callback(err, null);
        return;
      }

      if (!body.response || !body.response.tokens || !body.response.tokens.cookies) {
        callback(new Error('No cookies in Exchange response'), null);
        return;
      }
      if (!body.response.tokens.cookies[`.${amazonPage}`]) {
        callback(new Error(`No cookies for ${amazonPage} in Exchange response`), null);
        return;
      }

      let cookieString = addCookies('', response ? response.headers : null);
      const cookies = cookieTools.parse(cookieString);
      body.response.tokens.cookies[`.${amazonPage}`].forEach((cookie) => {
        cookies[cookie.Name] = cookie.Value;
      });
      cookieString = '';
      for (const name of Object.keys(cookies)) {
        cookieString += `${name}=${cookies[name]}; `;
      }
      callback(null, cookieString.replace(/[; ]*$/, ''));
    });
  }

  function getCSRFFromCookies(config, cookie, callback) {
    const csrfUrls = csrfOptions.slice();

    function csrfTry() {
      const csrfPath = csrfUrls.shift();
      const options = {
        host: `alexa.${config.amazonPage}`,
        path: csrfPath,
        method: 'GET',
        headers: {
          'DNT': '1',
          'User-Agent': config.userAgent,
          'Connection': 'keep-alive',
          'Referer': `https://alexa.${config.amazonPage}/spa/index.html`,
          'Cookie': cookie,
          'Accept': '*/*',
          'Origin': `https://alexa.${config.amazonPage}`,
        },
      };

      config.logger && config.logger(`Alexa-Cookie-Refresh: get CSRF via ${csrfPath}`);
      send(options, config, (error, response) => {
        cookie = addCookies(cookie, response ? response.headers : null);
        const ar = /csrf=([^;]+)/.exec(cookie);
        const csrf = ar ? ar[1] : undefined;
        if (!csrf && csrfUrls.length) {
          csrfTry();
          return;
        }
        callback(null, { cookie, csrf });
      });
    }

    csrfTry();
  }

  function registerTokenCapabilities(config, accessToken, callback) {
    const options = {
      host: 'api.amazonalexa.com',
      path: '/v1/devices/@self/capabilities',
      method: 'PUT',
      headers: {
        'User-Agent': apiCallUserAgent,
        'Accept-Language': config.acceptLanguage,
        'Accept-Charset': 'utf-8',
        'Connection': 'keep-alive',
        'Content-type': 'application/json; charset=UTF-8',
        'authorization': `Bearer ${accessToken}`,
      },
      body: CAPABILITIES_BODY,
    };
    config.logger && config.logger('Alexa-Cookie-Refresh: Register capabilities');
    send(options, config, (error, response) => {
      if (error || (response && response.statusCode !== 204 && response.statusCode !== 200)) {
        config.logger && config.logger('Alexa-Cookie-Refresh: Could not set capabilities, Push connection might not work!');
      }
      callback();
    });
  }

  /**
   * Complete the refresh WITHOUT calling /auth/register.
   * Keeps existing registration (refreshToken, deviceSerial, macDms),
   * refreshes marketplace cookies + CSRF, advances tokenDate.
   */
  function finishCookieRefresh(config, loginData, callback) {
    config.logger && config.logger('Alexa-Cookie-Refresh: Skip App registration during refresh and update local cookies');

    const updateLocalCookies = () => {
      const amazonPage = loginData.amazonPage || config.amazonPage;
      getLocalCookies(config, amazonPage, loginData.refreshToken, (err, localCookie) => {
        if (err) {
          callback(err, null);
          return;
        }

        loginData.localCookie = localCookie;
        getCSRFFromCookies({ ...config, amazonPage }, loginData.localCookie, (csrfErr, resData) => {
          if (csrfErr) {
            callback(new Error(`Error getting csrf for ${amazonPage}`), null);
            return;
          }
          loginData.localCookie = resData.cookie;
          loginData.csrf = resData.csrf;
          loginData.amazonPage = amazonPage;
          loginData.tokenDate = Date.now();
          delete loginData.authorization_code;
          delete loginData.verifier;
          loginData.dataVersion = 2;
          config.logger && config.logger('Alexa-Cookie-Refresh: Refresh finished with updated cookies and csrf');
          callback(null, loginData);
        });
      });
    };

    if (loginData.accessToken) {
      registerTokenCapabilities(config, loginData.accessToken, updateLocalCookies);
      return;
    }
    updateLocalCookies();
  }

  function refreshAlexaCookie(options, callback) {
    if (!options || !options.formerRegistrationData
      || !options.formerRegistrationData.loginCookie
      || !options.formerRegistrationData.refreshToken) {
      callback && callback(new Error('No former registration data provided for Cookie Refresh'), null);
      return;
    }

    const config = normalizeConfig(options);
    const registrationData = options.formerRegistrationData;

    const refreshData = {
      'app_name': config.deviceAppName,
      'app_version': apiCallVersion,
      'di.sdk.version': '6.12.4',
      'source_token': registrationData.refreshToken,
      'package_name': 'com.amazon.echo',
      'di.hw.version': 'iPhone',
      'platform': 'iOS',
      'requested_token_type': 'access_token',
      'source_token_type': 'refresh_token',
      'di.os.name': 'iOS',
      'di.os.version': '16.6',
      'current_version': '6.12.4',
    };

    const requestOptions = {
      host: `api.${config.baseAmazonPage}`,
      path: '/auth/token',
      method: 'POST',
      headers: {
        'User-Agent': apiCallUserAgent,
        'Accept-Language': config.acceptLanguage,
        'Accept-Charset': 'utf-8',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': registrationData.loginCookie,
        'Accept': 'application/json',
        'x-amzn-identity-auth-domain': `api.${config.baseAmazonPage}`,
      },
      body: querystring.stringify(refreshData),
    };

    config.logger && config.logger('Alexa-Cookie-Refresh: Refresh Token');
    send(requestOptions, config, (error, response, body) => {
      if (error) {
        callback && callback(error, null);
        return;
      }
      try {
        if (typeof body !== 'object') body = JSON.parse(body);
      } catch (err) {
        callback && callback(err, null);
        return;
      }

      registrationData.loginCookie = addCookies(registrationData.loginCookie, response ? response.headers : null);

      if (!body.access_token) {
        callback && callback(new Error('No new access token in Refresh Token response'), null);
        return;
      }
      registrationData.accessToken = body.access_token;

      getLocalCookies(config, config.baseAmazonPage, registrationData.refreshToken, (err, comCookie) => {
        if (err) {
          callback && callback(err, null);
          return;
        }

        // Restore frc and map-md — required by Amazon for future refreshes
        const initCookies = cookieTools.parse(registrationData.loginCookie);
        let newCookie = `frc=${initCookies.frc}; `;
        newCookie += `map-md=${initCookies['map-md']}; `;
        newCookie += comCookie;

        registrationData.loginCookie = newCookie;
        finishCookieRefresh(config, registrationData, callback);
      });
    });
  }

  return {
    refreshAlexaCookie,
    finishCookieRefresh,
    getLocalCookies,
    getCSRFFromCookies,
    registerTokenCapabilities,
    normalizeConfig,
  };
}

module.exports = {
  createAlexaCookieRefresh,
  addCookies,
};
