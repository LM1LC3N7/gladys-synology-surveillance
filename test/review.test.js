// -----------------------------------------------------------------------------
// Regressions of the review (milestone 1): races between the loops and the
// commands, unknown states, the motion events of a restart or an outage, the
// timer chains, the login rate, HTTP 429, "not sent" vs "no confirmation".
// The seven first cases are the reviewer's reproductions, turned into checks
// of the fixed behaviour.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SurveillanceApp } from '../src/app.js';
import { INTERVALS, MAX_STORED_IMAGE_LENGTH, SCENE_TRIGGERS } from '../src/constants.js';
import { buildCameraDevice, buildStationDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
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

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** A fake NAS whose answers can be held: `hold(predicate)` returns a release function. */
function holdable(nas) {
  const holds = [];
  const original = nas.request;
  nas.request = async (url, options = {}) => {
    const answer = await original(url, options); // computed NOW (state at request time)
    const params = Object.fromEntries(new URL(url).searchParams);
    const hold = holds.find((h) => !h.used && h.match(params, options));
    if (!hold) return answer;
    hold.used = true;
    await hold.gate;
    return answer;
  };
  return (match) => {
    let release;
    const gate = new Promise((r) => (release = r));
    holds.push({ match, gate, used: false });
    return () => release();
  };
}

async function setup({ config = {}, nas, dataDir } = {}) {
  const clock = { now: T0 };
  nas ??= createFakeNas({ clock });
  nas.clock = clock;
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE, ...config },
    devices: [cameraDevice(1), cameraDevice(2), cameraDevice(5), station()],
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l} ${a.join(' ')}`)]),
  );
  const app = new SurveillanceApp({
    gladys,
    logger,
    request: (...args) => nas.request(...args),
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'syno-review-')),
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, nas, timers, clock, logs, app };
}
const tick = () => new Promise((r) => setImmediate(r));
const homeEvents = (gladys) =>
  gladys.fake.sceneEvents
    .filter((e) => e.key === SCENE_TRIGGERS.HOME_MODE)
    .map((e) => e.data.state);
const motionEvents = (gladys) =>
  gladys.fake.sceneEvents.filter((e) => e.key === SCENE_TRIGGERS.MOTION);

test('RACE A: a status reading crossed by a Home Mode command is dropped (no spurious trigger)', async () => {
  const nas0 = createFakeNas();
  const hold = holdable(nas0);
  const { gladys, nas, timers } = await setup({
    nas: nas0,
    config: { allow_camera_control: true },
  });
  const release = hold(
    (p) => p.api === 'SYNO.SurveillanceStation.HomeMode' && p.method === 'GetInfo',
  );
  const loop = timers.run((ms) => ms === INTERVALS.STATUS_MS);
  await tick();
  await tick();
  const home = station();
  const ack = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.equal(ack.success, true);
  assert.equal(nas.homeMode, true);
  release();
  await loop;
  assert.equal(gladys.fake.lastState(feature(home, 'home_mode').external_id), 1);
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  assert.deepEqual(homeEvents(gladys), ['on']);
});

test('RACE B: "Allow reducing the surveillance" unticked while a Disable waits: not sent', async () => {
  const nas0 = createFakeNas();
  const hold = holdable(nas0);
  const { gladys, nas } = await setup({ nas: nas0, config: { allow_camera_control: true } });
  const garden = cameraDevice(1);
  const release = hold((p) => p.api === 'SYNO.SurveillanceStation.Camera' && p.method === 'List');
  const pending = gladys.fake.setValue(garden, feature(garden, 'enabled'), 0);
  await tick();
  await tick();
  await gladys.fake.configUpdated({ ...BASE, allow_camera_control: false });
  release();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing was sent/);
  assert.equal(nas.commands().length, 0);
  assert.equal(nas.cameras.find((c) => c.id === 1).enabled, true);
});

test('READ C: a camera without a readable "enabled" is unknown: refused, nothing published', async () => {
  const { gladys, nas } = await setup({ config: { allow_camera_control: true } });
  const garden = cameraDevice(1);
  delete nas.cameras.find((c) => c.id === 1).enabled;
  const ack = await gladys.fake.setValue(garden, feature(garden, 'enabled'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read/);
  assert.equal(nas.commands().length, 0);
  // The live image is still tried (unknown is not "disabled").
  const image = await gladys.fake.getImage(garden);
  assert.equal(image.success, true);
});

test('HOLE D: a motion event during a reconnection to Gladys fires after it, once', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'syno-review-'));
  const { gladys, nas, timers, clock, app } = await setup({ dataDir });
  const nowS = () => Math.floor(clock.now / 1000);
  await timers.run((ms) => ms === 1_000); // arms
  await app.stop(); // Gladys disconnected
  clock.now += 20_000;
  nas.events.unshift({
    eventId: 10,
    cameraId: 1,
    reason: 2,
    startTime: nowS() - 5,
    stopTime: nowS() - 1,
  });
  await app.start(await gladys.getConfig()); // reconnected
  await timers.run((ms) => ms === 1_000);
  clock.now += 10_000;
  await timers.run((ms) => ms === 10_000);
  assert.equal(motionEvents(gladys).length, 1, 'the event of the gap fires');
  // Another restart: the mark in /data says it was processed.
  await app.stop();
  await app.start(await gladys.getConfig());
  await timers.run((ms) => ms === 1_000);
  assert.equal(motionEvents(gladys).length, 1, 'not twice');
});

test('BURST E: after a 9-minute NAS outage, the old events do not fire at once', async () => {
  const { gladys, nas, timers, clock } = await setup();
  const nowS = () => Math.floor(clock.now / 1000);
  await timers.run((ms) => ms === 1_000); // arms
  nas.down = CODES.UNREACHABLE;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  const start = nowS();
  for (let i = 0; i < 6; i += 1) {
    nas.events.unshift({
      eventId: 100 + i,
      cameraId: 2,
      reason: 2,
      startTime: start + i * 80,
      stopTime: start + i * 80 + 20,
    });
  }
  clock.now += 9 * 60_000;
  nas.down = null;
  for (let i = 0; i < 6 && timers.pending.size; i += 1) {
    await timers.run((ms) => ms !== INTERVALS.STATUS_MS);
    if (gladys.fake.connectionStatus.connected) break;
  }
  await timers.run((ms) => ms === 1_000);
  assert.ok(motionEvents(gladys).length <= 1, `${motionEvents(gladys).length} fired`);
});

test('CHAINS G: an event poll in flight when the NAS fails does not leave a second chain', async () => {
  const nas0 = createFakeNas();
  const hold = holdable(nas0);
  const { nas, timers } = await setup({ nas: nas0 });
  await timers.run((ms) => ms === 1_000);
  const release = hold((p) => p.method === 'List' && p.api === 'SYNO.SurveillanceStation.Event');
  const poll = timers.run((ms) => ms === 10_000);
  await tick();
  nas.down = CODES.TIMEOUT;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  release();
  await poll;
  nas.down = null;
  await timers.run((ms) => ms === 30_000);
  const eventTimers = timers.delays().filter((ms) => ms === 1_000 || ms === 10_000);
  assert.equal(eventTimers.length, 1, 'one event chain');
});

test('LOOP F: a NAS that keeps dropping the session gets at most one login every 30 s', async () => {
  const { nas, timers, clock } = await setup({ config: { event_interval: '5' } });
  await timers.run((ms) => ms === 1_000);
  const original = nas.handle.bind(nas);
  nas.handle = (method, url, body) => {
    if (!url.includes('SYNO.API')) nas.sessions.clear();
    return original(method, url, body);
  };
  const before = nas.logins.length;
  for (let i = 0; i < 11; i += 1) {
    clock.now += 5_000;
    await timers.run((ms) => ms === 5_000);
  }
  assert.ok(nas.logins.length - before <= 2, `${nas.logins.length - before} logins in 55 s`);
});

test('HTTP 429: a bounded pause honouring Retry-After, commands refused meanwhile', async () => {
  const { gladys, nas, timers } = await setup();
  nas.httpError = { status: 429, headers: { 'retry-after': '120' } };
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down \(HTTP 429\)/);
  assert.deepEqual(timers.delays(), [120_000]);
  const before = nas.requests.length;
  const garage = cameraDevice(5);
  const ack = await gladys.fake.setValue(garage, feature(garage, 'enabled'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /slow down/);
  assert.equal(nas.requests.length, before);
  // Without Retry-After: the 1-minute floor. A 5xx: its own message.
  nas.httpError = { status: 503 };
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503\)/);
  nas.httpError = null;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a command that could not leave says "nothing was sent"; a lost answer says "no confirmation"', async () => {
  const nas = createFakeNas();
  const { gladys } = await setup({ nas, config: { allow_camera_control: true } });
  const home = station();
  const original = nas.request;
  nas.request = async (url, options) => {
    if (url.includes('method=Switch')) {
      const err = new SynologyError(CODES.UNREACHABLE, 'ECONNREFUSED');
      err.notSent = true;
      throw err;
    }
    return original(url, options);
  };
  const refused = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.match(refused.error, /could not reach the NAS .*nothing was sent/);
  nas.request = async (url, options) => {
    if (url.includes('method=Switch')) throw new SynologyError(CODES.TIMEOUT, 'late');
    return original(url, options);
  };
  const lost = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.match(lost.error, /No confirmation/);
});

test('the dashboard image: up to 150 KB when 60 KB is out of reach, warned once', async () => {
  const { gladys, nas, timers, logs } = await setup();
  nas.snapshotSizes[1] = 100_000;
  nas.snapshotSizes[2] = 80_000;
  await timers.run((ms) => ms === 2_000);
  await timers.run((ms) => ms === 60_000);
  const pushed = gladys.fake.cameraImages;
  assert.ok(pushed.length >= 2);
  assert.ok(pushed.every((i) => i.image.length > MAX_STORED_IMAGE_LENGTH));
  assert.equal(logs.filter((l) => l.includes('Camera 1: no snapshot under 60 KB')).length, 1);
});

test('the on/off state of a camera is the core camera/enabled feature', () => {
  const enabled = feature(cameraDevice(1), 'enabled');
  assert.equal(enabled.category, 'camera');
  assert.equal(enabled.type, 'enabled');
  assert.equal(enabled.read_only, false);
  assert.equal(enabled.has_feedback, true);
});

test('the live image: every request within 14 s', async () => {
  const { gladys, nas } = await setup();
  nas.snapshotSizes[1] = 140_000; // balanced too large: the low profile is asked
  nas.latency = 13_800; // the first snapshot leaves 200 ms
  const ack = await gladys.fake.getImage(cameraDevice(1));
  assert.equal(ack.success, false, 'the second snapshot would end past 14 s');
  assert.match(ack.error, /no answer in time/);
});
