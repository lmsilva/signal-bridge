/**
 * TLS material for the control web page.
 * Auto-generates a self-signed cert into data/web-certs/ on first use so the
 * phone can open a secure context (required for live camera QR on iOS Chrome).
 * No npm deps — RSA key + minimal X.509 via node:crypto.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function derLength(n) {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  if (n < 0x100) {
    return Buffer.from([0x81, n]);
  }
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function derTlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derIntegerFromBuffer(buf) {
  let bytes = Buffer.from(buf);
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return derTlv(0x02, bytes);
}

function derOid(oid) {
  const parts = oid.split('.').map((p) => Number(p));
  const body = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...stack);
  }
  return derTlv(0x06, Buffer.from(body));
}

function encodeUtcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const text = `${yy}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTlv(0x17, Buffer.from(text, 'ascii'));
}

function encodePrintableCn(cn) {
  const attrType = derOid('2.5.4.3'); // commonName
  const attrValue = derTlv(0x13, Buffer.from(cn, 'ascii')); // PrintableString
  const attr = derTlv(0x30, Buffer.concat([attrType, attrValue]));
  const set = derTlv(0x31, attr);
  return derTlv(0x30, set); // Name / RDNSequence
}

function encodeSubjectAltNames(hosts) {
  // GeneralNames: dNSName (2) or iPAddress (7)
  const names = hosts.map((host) => {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return derTlv(0x87, Buffer.from(host.split('.').map((o) => Number(o))));
    }
    return derTlv(0x82, Buffer.from(host, 'ascii'));
  });
  const generalNames = derTlv(0x30, Buffer.concat(names));
  const extnId = derOid('2.5.29.17');
  const extnValue = derTlv(0x04, generalNames);
  const extension = derTlv(0x30, Buffer.concat([extnId, extnValue]));
  const extensions = derTlv(0x30, extension);
  // Extensions are [3] EXPLICIT in TBSCertificate
  return derTlv(0xa3, extensions);
}

function buildTbsCertificate({ cn, hosts, publicKeyDer, serial, notBefore, notAfter }) {
  const version = derTlv(0xa0, derTlv(0x02, Buffer.from([0x02]))); // v3
  const serialDer = derIntegerFromBuffer(serial);
  const signatureAlg = derTlv(0x30, Buffer.concat([
    derOid('1.2.840.113549.1.1.11'), // sha256WithRSAEncryption
    derTlv(0x05, Buffer.alloc(0)), // NULL
  ]));
  const issuer = encodePrintableCn(cn);
  const validity = derTlv(0x30, Buffer.concat([
    encodeUtcTime(notBefore),
    encodeUtcTime(notAfter),
  ]));
  const subject = issuer;
  // SubjectPublicKeyInfo is already DER from export
  const spki = publicKeyDer;
  const san = encodeSubjectAltNames(hosts);
  return derTlv(0x30, Buffer.concat([
    version, serialDer, signatureAlg, issuer, validity, subject, spki, san,
  ]));
}

function pemEncode(type, der) {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

function generateWithNodeCrypto(keyPath, certPath, { cn, hosts, days }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const serial = crypto.randomBytes(8);
  const uniqueHosts = [...new Set([cn, ...hosts].filter(Boolean))];

  const tbs = buildTbsCertificate({
    cn,
    hosts: uniqueHosts,
    publicKeyDer: publicKey,
    serial,
    notBefore,
    notAfter,
  });

  const keyObj = crypto.createPrivateKey(privateKey);
  const signature = crypto.sign('sha256', tbs, keyObj);
  const signatureAlg = derTlv(0x30, Buffer.concat([
    derOid('1.2.840.113549.1.1.11'),
    derTlv(0x05, Buffer.alloc(0)),
  ]));
  // BIT STRING signatureValue
  const sigBitString = derTlv(0x03, Buffer.concat([Buffer.from([0x00]), signature]));
  const certDer = derTlv(0x30, Buffer.concat([tbs, signatureAlg, sigBitString]));

  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(certPath, pemEncode('CERTIFICATE', certDer), { mode: 0o644 });
}

function generateWithOpenSsl(keyPath, certPath, { cn, hosts, days }) {
  const san = hosts.map((h) => (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? `IP:${h}` : `DNS:${h}`
  )).join(',');
  const conf = `
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${cn}
[v3]
subjectAltName = ${san || `DNS:${cn}`}
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
`.trim();
  const confPath = `${certPath}.cnf`;
  fs.writeFileSync(confPath, conf);
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', String(days),
      '-config', confPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    try {
      fs.unlinkSync(confPath);
    } catch {
      // ignore
    }
  }
}

function resolveCertDir(config) {
  const rel = config.webServer?.certDir || 'data/web-certs';
  return path.resolve(config.ROOT || path.resolve(__dirname, '..'), rel);
}

function resolveTlsPaths(config) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const certDir = resolveCertDir(config);
  const certFileEnv = String(process.env.WEB_TLS_CERT_FILE || config.webServer?.certFile || '').trim();
  const keyFileEnv = String(process.env.WEB_TLS_KEY_FILE || config.webServer?.keyFile || '').trim();
  return {
    certDir,
    certPath: certFileEnv ? path.resolve(root, certFileEnv) : path.join(certDir, 'cert.pem'),
    keyPath: keyFileEnv ? path.resolve(root, keyFileEnv) : path.join(certDir, 'key.pem'),
  };
}

/**
 * Ensure key.pem + cert.pem exist; return { key, cert, keyPath, certPath, created }.
 * hosts: optional extra SANs (LAN IPs / hostnames) baked into a new cert.
 * If cert.pem/key.pem already exist (e.g. Let's Encrypt via issue-letsencrypt-cert.sh),
 * they are reused as-is and not overwritten.
 */
function ensureWebTls(config, { hosts = [], force = false } = {}) {
  const { certDir, keyPath, certPath } = resolveTlsPaths(config);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.mkdirSync(path.dirname(certPath), { recursive: true });
  const cn = config.webServer?.certCommonName || 'alexa-broadcast-control';
  const days = Number(config.webServer?.certDays) || 3650;
  const sanHosts = [
    cn,
    'localhost',
    '127.0.0.1',
    ...(Array.isArray(hosts) ? hosts : []),
    ...(Array.isArray(config.webServer?.certHosts) ? config.webServer.certHosts : []),
  ].filter(Boolean);

  let created = false;
  if (force || !fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const opts = { cn, hosts: sanHosts, days };
    try {
      generateWithOpenSsl(keyPath, certPath, opts);
    } catch {
      generateWithNodeCrypto(keyPath, certPath, opts);
    }
    created = true;
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    keyPath,
    certPath,
    certDir,
    created,
  };
}

module.exports = {
  ensureWebTls,
  resolveCertDir,
  resolveTlsPaths,
  generateWithNodeCrypto,
  generateWithOpenSsl,
};
