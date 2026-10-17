// -----------------------------------------------------------------------------
// SynologyClient: DSM's Web API for Surveillance Station.
//
//   SYNO.API.Info    query    which APIs the NAS offers, their path and versions
//   SYNO.API.Auth    login    POST (credentials in the body only), session
//                             "SurveillanceStation", format=sid; with a 2-step
//                             verification code once, then the device token
//   SYNO.SurveillanceStation.Camera     List, GetSnapshot, Enable, Disable
//   SYNO.SurveillanceStation.HomeMode   GetInfo, Switch
//   SYNO.SurveillanceStation.Event      List (or .Recording List)
//
// The request flow (API discovery, version choice, session error 119
// renewed once, the login parameters and the device token) is ported from
// py-synologydsm-api (mib1185, MIT; see THIRD_PARTY_NOTICES.md).
//
// Session rules: one login at a time (concurrent requests share it); a
// session error (106, 107, 119) renews the session ONCE per request, and not
// at all within 30 s of the previous login (no login loop); a refused login
// (wrong password, locked account, 2-step verification) is final: no request
// logs in again until the user changes the configuration or presses "Test
// the connection" (DSM blocks an address after a few failed logins).
// -----------------------------------------------------------------------------

import {
  API,
  INTERVALS,
  MAX_JPEG_BYTES,
  MAX_JSON_BYTES,
  PREFERRED_VERSIONS,
  SNAPSHOT_PROFILES,
  TIMEOUTS,
} from '../constants.js';
import { CODES, SESSION_CODES, SynologyError, isFinalAuthError } from './errors.js';
import { httpRequest } from './http.js';

/** Below this, a request is not sent at all (see `deadline`). */
const MIN_SEND_MS = 300;
const DEVICE_NAME = 'Gladys Assistant';

const toForm = (params) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

const asBool = (value) => value === true || value === 1 || value === 'true' || value === '1';
const asNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export class SynologyClient {
  /**
   * @param {object} options
   * @param {{ origin: string, hostname: string, port: number }} options.nas
   * @param {string} options.username
   * @param {string} options.password
   * @param {string} [options.otpCode] 2-step verification code typed by the user
   * @param {boolean} [options.allowSelfSigned]
   * @param {import('../store.js').Store} options.store loaded store
   * @param {Function} [options.request] the HTTP transport (tests inject a fake NAS)
   * @param {() => number} [options.now]
   */
  constructor({
    nas,
    username,
    password,
    otpCode = '',
    allowSelfSigned = false,
    store,
    request = httpRequest,
    now = Date.now,
  }) {
    this.nas = nas;
    this.username = username;
    this.password = password;
    this.otpCode = otpCode;
    this.allowSelfSigned = allowSelfSigned;
    this.store = store;
    this.request = request;
    this.now = now;
    this.accountKey = `${nas.origin}|${username}`;
    this.tlsKey = `${nas.hostname}:${nas.port}`;
    this.apis = null;
    this.sid = null;
    this.lastLoginAt = -Infinity;
    this.loginPromise = null;
    /** A final login refusal: kept until resetRefusal(). */
    this.refusal = null;
    this.closed = false;
  }

  // --- Transport -------------------------------------------------------------

  tlsOptions() {
    if (!this.allowSelfSigned) return {};
    return {
      trustOnFirstUse: true,
      pin: this.store.get('tlsPins', this.tlsKey),
      onPin: (fingerprint) => {
        this.store.set('tlsPins', this.tlsKey, fingerprint);
      },
    };
  }

  timeoutFor(deadline, fallback) {
    if (deadline === undefined) return fallback;
    const remaining = deadline - this.now();
    if (remaining < MIN_SEND_MS) {
      throw new SynologyError(CODES.TIMEOUT, 'No time left: request not sent');
    }
    return Math.min(fallback, remaining);
  }

  /**
   * One HTTP exchange with the NAS. JSON answers: resolves `data`, rejects
   * success:false as a SynologyError (API). `raw`: resolves the JPEG bytes.
   */
  async call(path, params, { post = false, raw = false, timeout = TIMEOUTS.API, deadline } = {}) {
    if (this.closed) throw new SynologyError(CODES.NOT_LOGGED_IN, 'Client closed');
    const url = new URL(`/webapi/${path}`, this.nas.origin);
    let body;
    if (post) {
      const { api, version, method, ...rest } = params;
      url.search = toForm({ api, version, method });
      body = toForm(rest);
    } else {
      url.search = toForm(params);
    }
    const response = await this.request(url.toString(), {
      method: post ? 'POST' : 'GET',
      body,
      timeout: this.timeoutFor(deadline, timeout),
      maxBytes: raw ? MAX_JPEG_BYTES : MAX_JSON_BYTES,
      tls: this.tlsOptions(),
    });
    if (response.status !== 200) {
      throw new SynologyError(CODES.HTTP, `HTTP ${response.status}`, { status: response.status });
    }
    const type = String(response.headers?.['content-type'] ?? '').toLowerCase();
    if (raw && type.startsWith('image/')) return response.body;
    let json;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new SynologyError(CODES.BAD_ANSWER, raw ? 'Not an image' : 'Not JSON');
    }
    if (!json || typeof json !== 'object') throw new SynologyError(CODES.BAD_ANSWER, 'Not JSON');
    if (json.success !== true) {
      const apiCode = asNumber(json.error?.code);
      if (apiCode === null) throw new SynologyError(CODES.BAD_ANSWER, 'Failure without a code');
      throw SynologyError.fromApi(params.api, apiCode);
    }
    if (raw) throw new SynologyError(CODES.BAD_ANSWER, 'Not an image');
    return json.data ?? {};
  }

  // --- API discovery ---------------------------------------------------------

  async discover({ deadline } = {}) {
    if (this.apis) return this.apis;
    const data = await this.call(
      'query.cgi',
      {
        api: API.INFO,
        version: 1,
        method: 'query',
        query: [API.AUTH, ...Object.values(API).filter((a) => a.startsWith('SYNO.Surv'))].join(','),
      },
      { deadline },
    );
    const auth = data[API.AUTH];
    if (!auth || typeof auth.path !== 'string') {
      throw new SynologyError(CODES.BAD_ANSWER, 'Not a Synology DSM answer');
    }
    this.apis = data;
    return data;
  }

  has(api) {
    return Boolean(this.apis?.[api]?.path);
  }

  /** Path and version of an API: the preferred version, within the NAS range. */
  endpoint(api) {
    const info = this.apis?.[api];
    if (!info || typeof info.path !== 'string' || !/^[a-z0-9_./-]+$/i.test(info.path)) {
      throw new SynologyError(CODES.NO_API, `${api} is not available on this NAS`);
    }
    const min = asNumber(info.minVersion) ?? 1;
    const max = asNumber(info.maxVersion) ?? min;
    const version = Math.max(min, Math.min(max, PREFERRED_VERSIONS[api] ?? max));
    return { path: info.path, version };
  }

  // --- Session ---------------------------------------------------------------

  /** After a final refusal, the user asked to try again (button, new configuration). */
  resetRefusal() {
    this.refusal = null;
  }

  login({ deadline } = {}) {
    if (this.refusal) return Promise.reject(this.refusal);
    this.loginPromise ??= this.doLogin({ deadline }).finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async doLogin({ deadline }) {
    await this.discover({ deadline });
    const { path, version } = this.endpoint(API.AUTH);
    const deviceToken = this.store.get('deviceTokens', this.accountKey);
    const usedOtp = this.store.get('usedOtp', this.accountKey);
    // A code is single-use: sent once, never again (it stays in the form).
    const otp = !deviceToken && this.otpCode && this.otpCode !== usedOtp ? this.otpCode : null;
    if (otp) await this.store.set('usedOtp', this.accountKey, otp);
    this.lastLoginAt = this.now();
    let data;
    try {
      data = await this.call(
        path,
        {
          api: API.AUTH,
          version,
          method: 'login',
          account: this.username,
          passwd: this.password,
          session: 'SurveillanceStation',
          format: 'sid',
          enable_device_token: 'yes',
          device_name: DEVICE_NAME,
          otp_code: otp ?? undefined,
          device_id: deviceToken ?? undefined,
        },
        { post: true, timeout: TIMEOUTS.LOGIN, deadline },
      );
    } catch (err) {
      if (isFinalAuthError(err)) {
        // DSM asks for a code although a device token was sent: it no longer
        // accepts it, forget it (the next code makes a new one).
        if (deviceToken && (err.apiCode === 403 || err.apiCode === 404)) {
          await this.store.set('deviceTokens', this.accountKey, null);
        }
        this.refusal = err;
      }
      throw err;
    }
    if (typeof data.sid !== 'string' || !data.sid) {
      throw new SynologyError(CODES.BAD_ANSWER, 'Login without a session id');
    }
    const did = data.did ?? data.device_id;
    if (typeof did === 'string' && did && did !== deviceToken) {
      await this.store.set('deviceTokens', this.accountKey, did);
    }
    this.sid = data.sid;
    return this.sid;
  }

  /**
   * An authenticated request. A session error renews the session once,
   * unless the last login is less than 30 s old.
   */
  async api(api, method, params = {}, options = {}) {
    await this.discover(options);
    const { path, version } = this.endpoint(api);
    const run = async () => {
      if (!this.sid) await this.login(options);
      const sid = this.sid;
      try {
        return await this.call(path, { api, version, method, ...params, _sid: sid }, options);
      } catch (err) {
        if (err.code === CODES.API && SESSION_CODES.has(err.apiCode) && this.sid === sid) {
          this.sid = null;
        }
        throw err;
      }
    };
    try {
      return await run();
    } catch (err) {
      const sessionLost = err.code === CODES.API && SESSION_CODES.has(err.apiCode);
      if (!sessionLost || this.now() - this.lastLoginAt < INTERVALS.MIN_LOGIN_GAP_MS) throw err;
      return run();
    }
  }

  async logout() {
    const sid = this.sid;
    this.sid = null;
    if (!sid || !this.has(API.AUTH)) return;
    const { path, version } = this.endpoint(API.AUTH);
    await this.call(path, {
      api: API.AUTH,
      version,
      method: 'logout',
      session: 'SurveillanceStation',
      _sid: sid,
    }).catch(() => {});
  }

  close() {
    this.closed = true;
  }

  // --- Surveillance Station --------------------------------------------------

  /** General information (model, version); null when the API is missing. */
  async stationInfo(options) {
    await this.discover(options);
    if (!this.has(API.SS_INFO)) return null;
    return this.api(API.SS_INFO, 'GetInfo', {}, options);
  }

  /** [{ id, name, enabled, status, model }] */
  async listCameras(options) {
    const data = await this.api(API.CAMERA, 'List', {}, options);
    if (!Array.isArray(data.cameras)) throw new SynologyError(CODES.BAD_ANSWER, 'No camera list');
    const cameras = [];
    for (const camera of data.cameras) {
      const id = asNumber(camera?.id);
      if (id === null || !Number.isInteger(id) || id < 0) continue;
      const name = String(camera.newName || camera.name || `Camera ${id}`).slice(0, 100);
      const model = [camera.vendor, camera.model]
        .filter((part) => typeof part === 'string' && part)
        .join(' ')
        .slice(0, 100);
      cameras.push({
        id,
        name,
        enabled: typeof camera.enabled === 'boolean' ? camera.enabled : asBool(camera.enabled),
        status: asNumber(camera.status ?? camera.camStatus),
        model: model || null,
      });
    }
    return cameras;
  }

  /** The JPEG of a camera, from the given profile. */
  async snapshot(id, { profile = SNAPSHOT_PROFILES.BALANCED, ...options } = {}) {
    return this.api(
      API.CAMERA,
      'GetSnapshot',
      { id, cameraId: id, profileType: profile },
      { raw: true, timeout: TIMEOUTS.SNAPSHOT, ...options },
    );
  }

  async setCameraEnabled(id, enabled, options) {
    await this.api(API.CAMERA, enabled ? 'Enable' : 'Disable', { idList: id }, options);
  }

  async hasHomeMode(options) {
    await this.discover(options);
    return this.has(API.HOME_MODE);
  }

  /** true: Home Mode on. */
  async homeMode(options) {
    const data = await this.api(API.HOME_MODE, 'GetInfo', {}, options);
    if (typeof data.on !== 'boolean')
      throw new SynologyError(CODES.BAD_ANSWER, 'No Home Mode state');
    return data.on;
  }

  async setHomeMode(on, options) {
    await this.api(API.HOME_MODE, 'Switch', { on: on ? 'true' : 'false' }, options);
  }

  /**
   * The recent events (recordings), newest first when the NAS sorts them:
   * [{ key, cameraId, reason, start, stop, ongoing }].
   */
  async events({ fromTime, limit }, options) {
    await this.discover(options);
    const api = this.has(API.EVENT) ? API.EVENT : API.RECORDING;
    const data = await this.api(api, 'List', { offset: 0, limit, fromTime }, options);
    const list = Array.isArray(data.events)
      ? data.events
      : Array.isArray(data.recordings)
        ? data.recordings
        : null;
    if (!list) throw new SynologyError(CODES.BAD_ANSWER, 'No event list');
    const events = [];
    for (const event of list) {
      const id = asNumber(event?.eventId ?? event?.id);
      const cameraId = asNumber(event?.cameraId ?? event?.camera_id ?? event?.camId);
      if (id === null || cameraId === null) continue;
      const start = asNumber(event.startTime ?? event.start_time) ?? 0;
      const stop = asNumber(event.stopTime ?? event.stop_time) ?? 0;
      events.push({
        key: `${cameraId}:${id}:${start}`,
        cameraId,
        reason: asNumber(event.reason) ?? 0,
        start,
        stop,
        ongoing: event.recording === true || stop === 0,
      });
    }
    return events;
  }
}
