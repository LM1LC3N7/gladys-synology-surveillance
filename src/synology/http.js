// -----------------------------------------------------------------------------
// The only network access of the integration: one request to the NAS on
// node:http / node:https. A deadline for the whole exchange, a size cap on
// the body, no redirect followed. Resolves { status, headers, body } for any
// status; rejects a SynologyError for the transport failures.
//
// TLS: by default the certificate must be valid for the host name (a public
// or system authority). With `tls.trustOnFirstUse`, a certificate that does
// not validate (DSM's own self-signed one) is accepted the first time and its
// SHA-256 fingerprint pinned; a different one later is refused until the user
// trusts it again. The handshake is checked BEFORE the request is written,
// so the password never reaches an unverified peer.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CODES, SynologyError } from './errors.js';

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
]);

function transportError(err) {
  const code = String(err?.code ?? '');
  if (TLS_ERRORS.has(code)) {
    return new SynologyError(CODES.TLS_UNTRUSTED, `Certificate refused (${code})`);
  }
  // Something answered, but not in HTTP / TLS (a wrong port or scheme).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL_')) {
    return new SynologyError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`);
  }
  return new SynologyError(CODES.UNREACHABLE, code || err?.message || 'Connection failed');
}

/**
 * @param {string} url absolute http(s) URL
 * @param {object} options
 * @param {'GET'|'POST'} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] url-encoded form (POST)
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {{ trustOnFirstUse?: boolean, pin?: string | null, onPin?: (fingerprint: string) => void }} [options.tls]
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeout, maxBytes, tls: trust = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const servername = net.isIP(host) ? undefined : host;
    let settled = false;
    let req = null;
    let socket = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        socket?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new SynologyError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`),
        ),
      timeout,
    );

    const send = (createConnection) => {
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      const options = {
        method,
        host,
        port,
        path: `${target.pathname}${target.search}`,
        headers: {
          accept: '*/*',
          host: target.host,
          ...(payload
            ? {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': String(payload.length),
              }
            : {}),
          ...headers,
        },
      };
      let lib = http;
      if (createConnection) {
        options.createConnection = createConnection;
      } else if (target.protocol === 'https:') {
        lib = https;
        options.servername = servername;
        options.rejectUnauthorized = true;
        options.agent = false;
      }
      req = lib.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new SynologyError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err)));
      });
      req.on('error', (err) => finish(transportError(err)));
      if (payload) req.write(payload);
      req.end();
    };

    if (target.protocol !== 'https:' || !trust.trustOnFirstUse) {
      send();
      return;
    }

    // Trust on first use: handshake first, decide, then write the request.
    socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    socket.once('error', (err) => finish(transportError(err)));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const fingerprint = String(cert?.fingerprint256 ?? '').toUpperCase();
      if (!fingerprint) {
        finish(new SynologyError(CODES.TLS_UNTRUSTED, 'No certificate'));
        return;
      }
      // A certificate that validates for this host needs no pin (renewals keep working).
      const valid = socket.authorized && !tls.checkServerIdentity(servername ?? host, cert);
      if (!valid) {
        const pin = trust.pin ? String(trust.pin).toUpperCase() : null;
        if (pin && pin !== fingerprint) {
          finish(new SynologyError(CODES.TLS_CHANGED, 'The certificate of the NAS changed'));
          return;
        }
        if (!pin) trust.onPin?.(fingerprint);
      }
      send(() => socket);
    });
  });
}
