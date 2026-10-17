// -----------------------------------------------------------------------------
// SynologyClient against the fake NAS: discovery, login, session renewal,
// refusals, 2-step verification, the Surveillance Station calls.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNasUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { SynologyClient } from '../src/synology/client.js';
import { CODES, isFinalAuthError } from '../src/synology/errors.js';
import { EVENTS, createFakeNas } from './helpers/fakeNas.js';

const T0 = Date.parse('2026-10-16T08:00:00Z');

async function setup({ nasOptions = {}, clientOptions = {}, store } = {}) {
  const clock = { now: T0 };
  const nas = createFakeNas({ clock, ...nasOptions });
  store ??= new Store({ filePath: join(mkdtempSync(join(tmpdir(), 'syno-')), 'store.json') });
  await store.load();
  const make = (extra = {}) =>
    new SynologyClient({
      nas: parseNasUrl('https://nas.local:5001'),
      username: 'gladys',
      password: 's3cret pass&=',
      store,
      request: nas.request,
      now: () => clock.now,
      ...clientOptions,
      ...extra,
    });
  return { nas, clock, store, client: make(), make };
}

test('discovery, then a login by POST with the credentials in the body only', async () => {
  const { nas, client } = await setup();
  const cameras = await client.listCameras();
  assert.deepEqual(
    cameras.map((c) => [c.id, c.name, c.enabled, c.status, c.model]),
    [
      [1, 'Garden', true, 1, 'Reolink RLC-810A'],
      [2, 'Entrée', true, 1, 'Hikvision DS-2CD2143G2-I'],
      [5, 'Garage', false, 7, 'Axis M3106-L Mk II'],
    ],
  );
  const [info, login, list] = nas.requests;
  assert.equal(info.path, '/webapi/query.cgi');
  assert.equal(login.method, 'POST');
  assert.equal(login.query.api, 'SYNO.API.Auth');
  assert.equal(login.query.version, '6', 'the preferred version, below the NAS maximum');
  assert.equal(login.query.passwd, undefined, 'no password in the URL');
  assert.equal(login.query.account, undefined);
  assert.equal(login.form.passwd, 's3cret pass&=', 'special characters survive the encoding');
  assert.equal(login.form.session, 'SurveillanceStation');
  assert.equal(list.query.version, '7', 'Camera.List capped at 7 like py-synologydsm-api');
  assert.equal(list.query._sid, 'sid-1');
});

test('a lost session is renewed once, and never in a loop', async () => {
  const { nas, client, clock } = await setup();
  await client.homeMode();
  assert.equal(nas.logins.length, 1);
  clock.now += 60_000;
  nas.expireSessions();
  assert.equal(await client.homeMode(), false);
  assert.equal(nas.logins.length, 2, 'renewed once');
  // Refused again right after the new login: no new login, the error goes up.
  nas.expireSessions();
  await assert.rejects(client.homeMode(), (err) => err.apiCode === 119);
  assert.equal(nas.logins.length, 2);
  // Concurrent requests share one login.
  clock.now += 60_000;
  await Promise.all([client.homeMode(), client.listCameras(), client.homeMode()]);
  assert.equal(nas.logins.length, 3);
});

test('a refused password is final: never tried again by the client itself', async () => {
  const { nas, client } = await setup({ clientOptions: { password: 'wrong' } });
  await assert.rejects(client.listCameras(), (err) => isFinalAuthError(err) && err.apiCode === 400);
  await assert.rejects(client.homeMode(), (err) => err.apiCode === 400);
  await assert.rejects(client.listCameras());
  assert.equal(nas.logins.length, 1, 'one login, whatever the number of requests');
  client.resetRefusal();
  await assert.rejects(client.listCameras());
  assert.equal(nas.logins.length, 2, 'tried again only when asked');
});

test('2-step verification: code asked, sent once, then the device token', async () => {
  const { nas, store, make } = await setup({ nasOptions: { otp: '654321' } });
  // No code: DSM asks for one; final.
  await assert.rejects(make().listCameras(), (err) => err.apiCode === 403 && isFinalAuthError(err));
  // A wrong code: final too, and that code is never sent again.
  const wrong = make({ otpCode: '111111' });
  await assert.rejects(wrong.listCameras(), (err) => err.apiCode === 404);
  await assert.rejects(make({ otpCode: '111111' }).listCameras(), (err) => err.apiCode === 403);
  assert.equal(nas.logins.at(-1).otp_code, undefined, 'a used code is not resent');
  // The right code: the device token is kept, the code is not needed again.
  await make({ otpCode: '654321' }).listCameras();
  const token = store.get('deviceTokens', 'https://nas.local:5001|gladys');
  assert.match(token, /^device-token-/);
  await make({ otpCode: '654321' }).listCameras();
  assert.deepEqual(nas.logins.at(-1), { method: 'POST', otp_code: undefined, device_id: token });
  // DSM forgets the device: the token is dropped, a new code is asked.
  nas.deviceIds.clear();
  await assert.rejects(make().listCameras(), (err) => err.apiCode === 403);
  assert.equal(store.get('deviceTokens', 'https://nas.local:5001|gladys'), null);
});

test('the Surveillance Station calls', async () => {
  const { nas, client } = await setup();
  const jpeg = await client.snapshot(1, { profile: 2 });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg.length, nas.snapshotSizes[2]);
  await assert.rejects(client.snapshot(5), (err) => err.code === CODES.API && err.apiCode === 402);
  await client.setCameraEnabled(5, true);
  assert.equal(nas.cameras.find((c) => c.id === 5).enabled, true);
  await client.setHomeMode(true);
  assert.equal(await client.homeMode(), true);
  nas.events = EVENTS.data.events;
  const events = await client.events({ fromTime: 1, limit: 50 });
  assert.deepEqual(events, [
    {
      key: '2:1203:1792137000',
      cameraId: 2,
      reason: 2,
      start: 1792137000,
      stop: 1792137042,
      ongoing: false,
    },
    { key: '1:1202:1792135800', cameraId: 1, reason: 1, start: 1792135800, stop: 0, ongoing: true },
  ]);
  const list = nas.requests.at(-1);
  assert.equal(list.query.api, 'SYNO.SurveillanceStation.Event');
  assert.equal(list.query.fromTime, '1');
});

test('the Recording API when the Event one is missing; a missing API is reported', async () => {
  const { nas, client } = await setup();
  delete nas.apiInfo['SYNO.SurveillanceStation.Event'];
  delete nas.apiInfo['SYNO.SurveillanceStation.HomeMode'];
  await client.events({ fromTime: 1, limit: 5 });
  assert.equal(nas.requests.at(-1).query.api, 'SYNO.SurveillanceStation.Recording');
  assert.equal(await client.hasHomeMode(), false);
  await assert.rejects(client.homeMode(), (err) => err.code === CODES.NO_API);
});

test('not DSM: a clear error, no login', async () => {
  const { nas, client } = await setup();
  nas.apiInfo = { 'Something.Else': {} };
  await assert.rejects(client.listCameras(), (err) => err.code === CODES.BAD_ANSWER);
  assert.equal(nas.logins.length, 0);
});

test('a deadline: nothing is sent once it has passed', async () => {
  const { nas, client, clock } = await setup();
  await client.homeMode();
  const before = nas.requests.length;
  await assert.rejects(
    client.setHomeMode(true, { deadline: clock.now + 100 }),
    (err) => err.code === CODES.TIMEOUT && err.notSent === true,
  );
  assert.equal(nas.requests.length, before, 'not sent');
});

test('versions per method: Camera.List at 7, the other Camera methods at 9', async () => {
  const { nas, client } = await setup();
  await client.listCameras();
  await client.snapshot(1);
  await client.setCameraEnabled(1, true);
  const versions = nas.requests
    .filter((r) => r.query.api === 'SYNO.SurveillanceStation.Camera')
    .map((r) => `${r.query.method}:${r.query.version}`);
  assert.deepEqual(versions, ['List:7', 'GetSnapshot:9', 'Enable:9']);
});

test('the camera fields: enabled unknown stays unknown, camStatus first', async () => {
  const { nas, client } = await setup();
  delete nas.cameras[0].enabled;
  nas.cameras[1].enabled = 'true';
  nas.cameras[2].camStatus = undefined;
  nas.cameras[2].status = 3;
  const cameras = await client.listCameras();
  assert.deepEqual(
    cameras.map((c) => [c.id, c.enabled, c.status]),
    [
      [1, null, 1],
      [2, null, 1],
      [5, false, 3],
    ],
    'only a boolean is an enabled state; status 0 of the fixture is not the camera status',
  );
});

test('events: no stop time is not "still recording"; null and booleans are no numbers', async () => {
  const { nas, client } = await setup();
  nas.events = [
    { eventId: 1, cameraId: 1, reason: 2, startTime: 100 },
    { eventId: 2, cameraId: 1, reason: 2, startTime: 100, stopTime: '' },
    { eventId: 3, cameraId: 1, reason: 2, startTime: 100, stopTime: 0 },
    { eventId: null, cameraId: 1, reason: 2, startTime: 100 },
    { eventId: 4, cameraId: true, reason: 2, startTime: 100 },
    { eventId: 5, cameraId: 1, reason: 2, startTime: null },
  ];
  const events = await client.events({ fromTime: 1, limit: 50 });
  assert.deepEqual(
    events.map((e) => [e.key, e.stop, e.ongoing]),
    [
      ['1:1:100', null, false],
      ['1:2:100', null, false],
      ['1:3:100', 0, true],
    ],
  );
});

test('a snapshot is recognized by its bytes, whatever its content type', async () => {
  const { nas, client } = await setup();
  nas.snapshotType = 'application/octet-stream';
  const jpeg = await client.snapshot(1);
  assert.equal(jpeg.length, nas.snapshotSizes[1]);
});

test('at most one login every 30 s, even when the NAS keeps dropping the session', async () => {
  const { nas, client, clock } = await setup();
  await client.homeMode();
  const original = nas.handle.bind(nas);
  nas.handle = (method, url, body) => {
    if (!url.includes('SYNO.API')) nas.sessions.clear();
    return original(method, url, body);
  };
  for (let i = 0; i < 11; i += 1) {
    clock.now += 5_000;
    await client.homeMode().catch(() => {});
  }
  assert.ok(nas.logins.length <= 3, `${nas.logins.length} logins in 55 s`);
  await assert.rejects(client.homeMode(), (err) => err.notSent === true || err.apiCode === 119);
});

test('HTTP errors carry their status and Retry-After', async () => {
  const { nas, client } = await setup();
  nas.httpError = { status: 429, headers: { 'retry-after': '120' } };
  await assert.rejects(
    client.listCameras(),
    (err) => err.code === CODES.HTTP && err.status === 429 && err.retryAfterMs === 120_000,
  );
});
