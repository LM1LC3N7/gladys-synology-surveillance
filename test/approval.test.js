// -----------------------------------------------------------------------------
// Regressions of the approval round: the clocks of the NAS and of Gladys
// (SKEW), events sharing a start second (TIE), the HTTP 429 pause across
// restarts and from a command (429), the text of a postponed login.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SurveillanceApp } from '../src/app.js';
import { INTERVALS, SCENE_TRIGGERS } from '../src/constants.js';
import { buildCameraDevice, buildStationDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { reasonOf } from '../src/i18n.js';
import { CODES, SynologyError } from '../src/synology/errors.js';
import { CAMERA_LIST, createFakeNas } from './helpers/fakeNas.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-16T08:00:00Z');
const SELECTOR = 'synology-surveillance';
const ids = createFakeGladys({ selector: SELECTOR });
const cameraDevice = (id) =>
  buildCameraDevice(
    ids,
    CAMERA_LIST.data.cameras
      .filter((c) => c.id === id)
      .map((c) => ({ id: c.id, name: c.name, model: null }))[0],
  );
const station = () => buildStationDevice(ids);
const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const BASE = { url: 'https://nas.local:5001', username: 'gladys', password: 's3cret pass&=' };

const apps = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup({ config = {}, nas, dataDir, clock } = {}) {
  clock ??= { now: T0 };
  nas ??= createFakeNas({ clock });
  nas.clock = clock;
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE, ...config },
    devices: [cameraDevice(1), cameraDevice(2), cameraDevice(5), station()],
  });
  const timers = createFakeTimers();
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, () => {}]));
  const app = new SurveillanceApp({
    gladys,
    logger,
    request: (...args) => nas.request(...args),
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'syno-appr-')),
    now: () => clock.now,
    timers,
  });
  apps.push(app);
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, nas, timers, clock, app };
}
const motion = (gladys) => gladys.fake.sceneEvents.filter((e) => e.key === SCENE_TRIGGERS.MOTION);
const motionState = (gladys, id) =>
  gladys.fake.lastState(feature(cameraDevice(id), 'motion').external_id);
const event = (eventId, cameraId, start, stop) => ({
  eventId,
  cameraId,
  reason: 2,
  startTime: start,
  stopTime: stop,
});

for (const skew of [-180_000, 180_000]) {
  test(`SKEW ${skew / 1000} s, steady running: a fresh motion event fires`, async () => {
    const clock = { now: T0 };
    const nas = createFakeNas({ clock });
    nas.clockSkewMs = skew;
    const { gladys, timers } = await setup({ nas, clock });
    await timers.run((ms) => ms === 1_000); // catches up (nothing), arms
    clock.now += 10_000;
    nas.events.unshift(event(7, 1, nas.nowS() - 6, nas.nowS() - 2));
    await timers.run((ms) => ms === 10_000);
    assert.equal(motion(gladys).length, 1);
    assert.equal(motionState(gladys, 1), 1);
  });

  test(`SKEW ${skew / 1000} s, after a restart: the NAS time decides, nothing fires twice`, async () => {
    const clock = { now: T0 };
    const nas = createFakeNas({ clock });
    nas.clockSkewMs = skew;
    const dataDir = mkdtempSync(join(tmpdir(), 'syno-appr-'));
    const { gladys, timers, app } = await setup({ nas, clock, dataDir });
    await timers.run((ms) => ms === 1_000);
    clock.now += 10_000;
    nas.events.unshift(event(8, 1, nas.nowS() - 6, nas.nowS() - 2));
    await timers.run((ms) => ms === 10_000);
    assert.equal(motion(gladys).length, 1);
    await app.stop();
    clock.now += 20_000;
    nas.events.unshift(event(9, 2, nas.nowS() - 5, nas.nowS() - 1)); // during the gap
    await app.start(await gladys.getConfig());
    await timers.run((ms) => ms === 1_000);
    assert.deepEqual(
      motion(gladys).map((e) => e.data.camera_name),
      ['Garden', 'Entrée'],
      'the event of the gap fires (recent in NAS time), the old one not again',
    );
  });
}

test('SKEW: the catch-up after an outage uses the NAS time', async () => {
  const clock = { now: T0 };
  const nas = createFakeNas({ clock });
  nas.clockSkewMs = -180_000;
  const { gladys, timers } = await setup({ nas, clock });
  await timers.run((ms) => ms === 1_000);
  nas.down = CODES.UNREACHABLE;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  clock.now += 5 * 60_000;
  nas.events.unshift(event(30, 1, nas.nowS() - 300, nas.nowS() - 290)); // old
  nas.events.unshift(event(31, 2, nas.nowS() - 10, nas.nowS() - 5)); // recent
  nas.down = null;
  await timers.run((ms) => ms === 30_000);
  await timers.run((ms) => ms === 1_000);
  assert.deepEqual(
    motion(gladys).map((e) => e.data.camera_name),
    ['Entrée'],
  );
});

test('TIE: two events sharing their start second, then a restart: none fires twice', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'syno-appr-'));
  const { gladys, nas, timers, clock, app } = await setup({ dataDir });
  await timers.run((ms) => ms === 1_000);
  clock.now += 10_000;
  const s = nas.nowS() - 4;
  nas.events.unshift(event(20, 1, s, s + 2), event(21, 2, s, s + 2));
  await timers.run((ms) => ms === 10_000);
  assert.equal(motion(gladys).length, 2);
  await app.stop();
  clock.now += 5_000;
  await app.start(await gladys.getConfig());
  await timers.run((ms) => ms === 1_000);
  assert.equal(motion(gladys).length, 2);
});

test('429: the pause outlives a reconnection to Gladys and a restart; saving lifts it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'syno-appr-'));
  const clock = { now: T0 };
  const nas = createFakeNas({ clock });
  const { gladys, timers, app } = await setup({ nas, clock, dataDir });
  nas.httpError = { status: 429, headers: { 'retry-after': '3600' } };
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  nas.httpError = null;
  let before = nas.requests.length;
  await app.stop();
  await app.start(await gladys.getConfig()); // the 'connected' handler
  assert.equal(nas.requests.length - before, 0, 'no request during the pause');
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.ok(
    timers.delays().some((ms) => ms > 3_000_000 && ms <= 3_600_000),
    'resumes after it',
  );
  await app.stop();

  const second = await setup({ nas, clock, dataDir }); // a restart of the container
  assert.equal(nas.requests.length - before, 0);
  before = nas.requests.length;
  await second.gladys.fake.configUpdated({ ...BASE }); // the user saves: tried now
  assert.ok(nas.requests.length > before);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
});

test('429 answered to a command: refused, not done, and everything pauses', async () => {
  const nas = createFakeNas();
  const { gladys, timers } = await setup({ nas, config: { allow_camera_control: true } });
  const home = station();
  const original = nas.request;
  nas.request = async (url, options) => {
    if (url.includes('method=Switch')) {
      const err = new SynologyError(CODES.HTTP, 'HTTP 429', { status: 429 });
      err.retryAfterMs = 600_000;
      throw err;
    }
    return original(url, options);
  };
  const ack = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /HTTP 429.*nothing was done/);
  assert.equal(nas.homeMode, false);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [600_000]);
  const image = await gladys.fake.getImage(cameraDevice(1));
  assert.equal(image.success, false);
});

test('a postponed login reads as such', () => {
  assert.match(
    reasonOf(new SynologyError(CODES.NOT_LOGGED_IN, 'x')).en,
    /not logged in to the NAS yet/,
  );
});
