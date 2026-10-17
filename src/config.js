// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { EVENT_INTERVALS, IMAGE_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  allow_self_signed: false,
  allow_camera_control: false,
  event_interval: '10',
  image_refresh: '60',
});

/** DSM's own default ports. */
export const DEFAULT_PORTS = Object.freeze({ 'http:': 5000, 'https:': 5001 });

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The address of the NAS: `https://host:port`, `http://host:port`, or a bare
 * `host[:port]` read as https (port 5001 when none is typed). Credentials, a
 * path, a query and a fragment are refused (the password has its own field,
 * and an address ends up in logs).
 *   -> { origin, protocol, hostname, port } or { error: 'empty' | 'invalid' | 'credentials' }
 */
export function parseNasUrl(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'invalid' };
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname) return { error: 'invalid' };
  if (url.pathname !== '/' && url.pathname !== '') return { error: 'invalid' };
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  const hostname = url.hostname.toLowerCase();
  return {
    origin: `${url.protocol}//${hostname}:${port}`,
    protocol: url.protocol,
    hostname,
    port,
  };
}

/** A one-time code of the 2-step verification: 6 digits, spaces ignored. */
export function parseOtp(value) {
  const digits = text(value).replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const nas = parseNasUrl(raw.url);
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  return {
    nas: nas.error ? null : nas,
    urlError: nas.error ?? null,
    username: text(raw.username),
    password: typeof raw.password === 'string' ? raw.password : '',
    otpCode: parseOtp(raw.otp_code),
    otpInvalid: text(raw.otp_code) !== '' && parseOtp(raw.otp_code) === '',
    allowSelfSigned: bool(raw.allow_self_signed, DEFAULTS.allow_self_signed),
    allowControl: bool(raw.allow_camera_control, DEFAULTS.allow_camera_control),
    eventSeconds: Number(pick('event_interval', EVENT_INTERVALS)),
    imageSeconds: Number(pick('image_refresh', IMAGE_INTERVALS)),
  };
}
