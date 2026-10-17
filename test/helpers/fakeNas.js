// -----------------------------------------------------------------------------
// A fake Synology NAS with Surveillance Station: DSM's Web API in memory,
// shaped after test/fixtures. `nas.request` is a drop-in for the transport of
// src/synology/http.js (no network); `nas.listen()` serves the same API on a
// loopback port for the tests of the real transport.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { SynologyError, CODES } from '../../src/synology/errors.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export const API_INFO = fixture('api-info.json');
export const CAMERA_LIST = fixture('camera-list.json');
export const EVENTS = fixture('events.json');

/** A JPEG-looking buffer of `size` bytes (SOI ... EOI). */
export function jpegOf(size) {
  const bytes = Buffer.alloc(Math.max(size, 4), 0x42);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

const json = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset="UTF-8"' },
  body: Buffer.from(JSON.stringify(value)),
});
const ok = (data = {}) => json({ data, success: true });
const fail = (code) => json({ error: { code }, success: false });

export function createFakeNas({
  username = 'gladys',
  password = 's3cret pass&=',
  otp = null,
  clock = null,
} = {}) {
  let nextSid = 1;
  let nextDid = 1;
  const nas = {
    username,
    password,
    otp,
    clock,
    cameras: structuredClone(CAMERA_LIST.data.cameras),
    homeMode: false,
    events: [],
    apiInfo: structuredClone(API_INFO.data),
    sessions: new Set(),
    deviceIds: new Set(),
    logins: [],
    requests: [],
    /** ms added to the clock by every request (a slow NAS, without waiting). */
    latency: 0,
    /** Transport failure of every request: a SynologyError code, or null. */
    down: null,
    /** JPEG size per profile (0 high, 1 balanced, 2 low). */
    snapshotSizes: { 0: 200_000, 1: 40_000, 2: 20_000 },
    /** The DSM error the next requests of an API answer, by api name. */
    apiErrors: {},

    expireSessions() {
      this.sessions.clear();
    },
    /** The requests that change something. */
    commands() {
      return this.requests.filter((r) => ['Enable', 'Disable', 'Switch'].includes(r.params.method));
    },

    handle(method, url, body) {
      const target = new URL(url);
      const params = Object.fromEntries(target.searchParams);
      const form = body ? Object.fromEntries(new URLSearchParams(body)) : {};
      const all = { ...params, ...form };
      this.requests.push({ method, path: target.pathname, query: params, params: all, form });
      if (this.clock) this.clock.now += this.latency;

      if (target.pathname === '/webapi/query.cgi' && all.api === 'SYNO.API.Info') {
        return ok(this.apiInfo);
      }
      if (target.pathname !== '/webapi/entry.cgi') {
        return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nope') };
      }
      const forced = this.apiErrors[all.api];
      if (forced) return fail(forced);
      if (all.api === 'SYNO.API.Auth') return this.auth(all, method);
      if (!this.sessions.has(all._sid)) return fail(119);
      switch (`${all.api}.${all.method}`) {
        case 'SYNO.SurveillanceStation.Info.GetInfo':
          return ok({ hostname: 'nas', serial: '1234ABCD', version: { major: 9 } });
        case 'SYNO.SurveillanceStation.Camera.List':
          return ok({ cameras: this.cameras, total: this.cameras.length });
        case 'SYNO.SurveillanceStation.Camera.GetSnapshot': {
          const camera = this.cameras.find((c) => c.id === Number(all.id));
          if (!camera) return fail(401);
          if (!camera.enabled) return fail(402);
          return {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
            body: jpegOf(this.snapshotSizes[Number(all.profileType)] ?? 40_000),
          };
        }
        case 'SYNO.SurveillanceStation.Camera.Enable':
        case 'SYNO.SurveillanceStation.Camera.Disable': {
          const camera = this.cameras.find((c) => c.id === Number(all.idList));
          if (!camera) return fail(401);
          camera.enabled = all.method === 'Enable';
          camera.status = camera.enabled ? 1 : 7;
          return ok();
        }
        case 'SYNO.SurveillanceStation.HomeMode.GetInfo':
          return ok({ on: this.homeMode, reason: 0 });
        case 'SYNO.SurveillanceStation.HomeMode.Switch':
          this.homeMode = all.on === 'true';
          return ok();
        case 'SYNO.SurveillanceStation.Event.List':
        case 'SYNO.SurveillanceStation.Recording.List':
          return ok({ events: this.events, offset: 0, total: this.events.length });
        default:
          return fail(103);
      }
    },

    auth(all, method) {
      if (all.method === 'logout') {
        this.sessions.delete(all._sid);
        return ok();
      }
      if (all.method !== 'login') return fail(103);
      this.logins.push({ method, otp_code: all.otp_code, device_id: all.device_id });
      if (method !== 'POST') return fail(101);
      if (all.account !== this.username || all.passwd !== this.password) return fail(400);
      let did;
      if (this.otp && !this.deviceIds.has(all.device_id)) {
        if (!all.otp_code) return fail(403);
        if (all.otp_code !== this.otp) return fail(404);
        did = `device-token-${nextDid++}`;
        this.deviceIds.add(did);
      }
      const sid = `sid-${nextSid++}`;
      this.sessions.add(sid);
      return ok({ sid, ...(did ? { did } : {}), is_portal_port: false });
    },

    /** The transport of src/synology/http.js. */
    request: async (url, options = {}) => {
      if (nas.down) throw new SynologyError(nas.down, `fake ${nas.down}`);
      return nas.handle(options.method ?? 'GET', url, options.body);
    },

    /** Serve the API on 127.0.0.1 (random port). Resolves { url, close }. */
    async listen() {
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const answer = nas.handle(
            req.method,
            `http://${req.headers.host}${req.url}`,
            Buffer.concat(chunks).toString('utf8') || undefined,
          );
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body);
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    },
  };
  return nas;
}

export { CODES };
