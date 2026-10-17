// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake NAS, through the
// exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SurveillanceApp } from '../src/app.js';
import {
  ACTIONS,
  IMAGE_PREFIX,
  INTERVALS,
  MAX_IMAGE_LENGTH,
  MAX_STORED_IMAGE_LENGTH,
  SCENE_TRIGGERS,
} from '../src/constants.js';
import { buildCameraDevice, buildStationDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { CODES } from '../src/synology/errors.js';
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
const BASE_CONFIG = {
  url: 'https://nas.local:5001',
  username: 'gladys',
  password: 's3cret pass&=',
};

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ config = {}, created = [1, 2, 5], withStation = true, nas, dataDir } = {}) {
  const clock = { now: T0 };
  nas ??= createFakeNas({ clock });
  nas.clock = clock;
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: [...created.map(cameraDevice), ...(withStation ? [station()] : [])],
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new SurveillanceApp({
    gladys,
    logger,
    request: nas.request,
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'syno-app-')),
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, nas, timers, clock, logs, app };
}

const events = (gladys, key) => gladys.fake.sceneEvents.filter((e) => e.key === key);
const runEvents = (timers, seconds = 10) =>
  timers.run((ms) => ms === 1_000 || ms === seconds * 1000);

test('start: Discovery gets the station and every camera; states and badges', async () => {
  const { gladys, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Surveillance Station answers: 3 cameras. Home Mode off.',
      fr: 'Surveillance Station répond : 3 caméras. Mode Maison désactivé.',
    },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:station:main`, 'Surveillance Station'],
      [`ext:${SELECTOR}:camera:1`, 'Garden'],
      [`ext:${SELECTOR}:camera:2`, 'Entrée'],
      [`ext:${SELECTOR}:camera:5`, 'Garage'],
    ],
  );
  const garage = cameraDevice(5);
  assert.equal(gladys.fake.lastState(feature(garage, 'enabled').external_id), 0);
  assert.equal(gladys.fake.lastState(feature(cameraDevice(1), 'enabled').external_id), 1);
  assert.equal(gladys.fake.lastState(feature(station(), 'home_mode').external_id), 0);
  assert.deepEqual(
    gladys.fake.transports.map((t) => t.transport),
    ['local', 'local', 'local', 'local'],
  );
  assert.deepEqual(
    timers.delays().sort((a, b) => a - b),
    [1_000, 2_000, INTERVALS.STATUS_MS],
  );
});

test('motion: the first reading arms, a new motion event fires once and sets the sensor', async () => {
  const { gladys, nas, timers, clock } = await setup();
  const nowS = () => Math.floor(clock.now / 1000);
  nas.events = [
    { eventId: 1, cameraId: 2, reason: 2, startTime: nowS() - 600, stopTime: nowS() - 590 },
    { eventId: 2, cameraId: 1, reason: 1, startTime: nowS() - 900, stopTime: 0, recording: true },
  ];
  await runEvents(timers);
  assert.equal(events(gladys, SCENE_TRIGGERS.MOTION).length, 0, 'old events fire nothing');
  const motion = (id) => gladys.fake.lastState(feature(cameraDevice(id), 'motion').external_id);
  assert.equal(motion(2), 0);
  assert.equal(motion(1), 0, 'a continuous recording is not a motion');

  clock.now += 10_000;
  nas.events.unshift({
    eventId: 3,
    cameraId: 2,
    reason: 2,
    startTime: nowS() - 2,
    stopTime: 0,
    recording: true,
  });
  nas.events.unshift({
    eventId: 4,
    cameraId: 1,
    reason: 7,
    startTime: nowS() - 1,
    stopTime: nowS(),
  });
  await runEvents(timers);
  assert.deepEqual(
    events(gladys, SCENE_TRIGGERS.MOTION).map((e) => e.data),
    [
      { camera: `ext:${SELECTOR}:camera:2`, camera_name: 'Entrée', reason: 'motion' },
      { camera: `ext:${SELECTOR}:camera:1`, camera_name: 'Garden', reason: 'analytics' },
    ],
  );
  assert.equal(motion(2), 1);
  assert.equal(motion(1), 1);

  // Read again: nothing fires twice; the ongoing one keeps its sensor on.
  clock.now += 40_000;
  await runEvents(timers);
  assert.equal(events(gladys, SCENE_TRIGGERS.MOTION).length, 2);
  assert.equal(motion(2), 1);
  assert.equal(motion(1), 0, 'a finished event lets the sensor go back');
});

test('Home Mode: a change seen fires the trigger; not the first reading', async () => {
  const { gladys, nas, timers } = await setup();
  assert.equal(events(gladys, SCENE_TRIGGERS.HOME_MODE).length, 0);
  nas.homeMode = true;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  assert.deepEqual(
    events(gladys, SCENE_TRIGGERS.HOME_MODE).map((e) => e.data),
    [{ state: 'on' }],
  );
  assert.equal(gladys.fake.lastState(feature(station(), 'home_mode').external_id), 1);
});

test('images: live under 150 KB (balanced, else low), pushed under 60 KB', async () => {
  const { gladys, nas, timers } = await setup();
  const ack = await gladys.fake.getImage(cameraDevice(1));
  assert.equal(ack.success, true);
  assert.ok(ack.data.image.startsWith(IMAGE_PREFIX));
  assert.ok(ack.data.image.length <= MAX_IMAGE_LENGTH);
  assert.equal(nas.requests.at(-1).query.profileType, '1');

  nas.snapshotSizes[1] = 140_000;
  const smaller = await gladys.fake.getImage(cameraDevice(1));
  assert.equal(smaller.success, true);
  assert.equal(nas.requests.at(-1).query.profileType, '2');

  const disabled = await gladys.fake.getImage(cameraDevice(5));
  assert.equal(disabled.success, false);
  assert.match(disabled.error, /disabled/);

  nas.snapshotSizes[1] = 40_000;
  nas.snapshotSizes[2] = 20_000;
  await timers.run((ms) => ms === 2_000);
  const pushed = gladys.fake.cameraImages;
  assert.deepEqual(
    pushed.map((i) => i.device_external_id),
    [`ext:${SELECTOR}:camera:1`, `ext:${SELECTOR}:camera:2`],
    'the disabled camera is skipped',
  );
  assert.ok(pushed.every((i) => i.image.length <= MAX_STORED_IMAGE_LENGTH));
});

test('commands by default: more surveillance yes, less surveillance refused before any request', async () => {
  const { gladys, nas } = await setup();
  const garden = cameraDevice(1);
  const garage = cameraDevice(5);
  const home = station();
  const before = nas.requests.length;
  const off = await gladys.fake.setValue(garden, feature(garden, 'enabled'), 0);
  assert.equal(off.success, false);
  assert.match(off.error, /reduces the surveillance/);
  const homeOn = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.equal(homeOn.success, false);
  assert.equal(nas.requests.length, before, 'nothing asked to the NAS');

  const on = await gladys.fake.setValue(garage, feature(garage, 'enabled'), 1);
  assert.equal(on.success, true);
  const [read, command] = nas.requests.slice(before).map((r) => r.query.method);
  assert.deepEqual([read, command], ['List', 'Enable'], 'the state read just before acting');
  assert.equal(gladys.fake.lastState(feature(garage, 'enabled').external_id), 1);

  // Already in that state: nothing sent.
  const again = await gladys.fake.setValue(garage, feature(garage, 'enabled'), 1);
  assert.equal(again.success, true);
  assert.equal(nas.commands().length, 1);

  const homeOff = await gladys.fake.setValue(home, feature(home, 'home_mode'), 0);
  assert.equal(homeOff.success, true);
  assert.equal(nas.commands().length, 1, 'Home Mode was already off');
});

test('commands allowed: disable a camera, Home Mode on (trigger); serialized', async () => {
  const { gladys, nas } = await setup({ config: { allow_camera_control: true } });
  const garden = cameraDevice(1);
  const entry = cameraDevice(2);
  const home = station();
  const start = nas.requests.length;
  const acks = await Promise.all([
    gladys.fake.setValue(garden, feature(garden, 'enabled'), 0),
    gladys.fake.setValue(entry, feature(entry, 'enabled'), 0),
    gladys.fake.setValue(home, feature(home, 'home_mode'), 1),
  ]);
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
  assert.deepEqual(
    nas.requests.slice(start).map((r) => r.query.method),
    ['List', 'Disable', 'List', 'Disable', 'GetInfo', 'Switch'],
    'one command at a time, each read just before',
  );
  assert.equal(nas.cameras.find((c) => c.id === 1).enabled, false);
  assert.equal(nas.homeMode, true);
  assert.deepEqual(
    events(gladys, SCENE_TRIGGERS.HOME_MODE).map((e) => e.data),
    [{ state: 'on' }],
  );
});

test('a slow NAS: past the budget, nothing is sent', async () => {
  const { gladys, nas } = await setup({ config: { allow_camera_control: true } });
  const home = station();
  nas.latency = 2_600; // the fresh read eats the budget
  const ack = await gladys.fake.setValue(home, feature(home, 'home_mode'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing was sent/);
  assert.equal(nas.commands().length, 0);
  assert.equal(nas.homeMode, false);
});

test('an unknown state refuses the command', async () => {
  const { gladys, nas } = await setup();
  const garage = cameraDevice(5);
  nas.apiErrors['SYNO.SurveillanceStation.Camera'] = 400;
  const ack = await gladys.fake.setValue(garage, feature(garage, 'enabled'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read/);
  assert.equal(nas.commands().length, 0);
  delete nas.apiErrors['SYNO.SurveillanceStation.Camera'];
  nas.cameras = nas.cameras.filter((c) => c.id !== 5);
  const gone = await gladys.fake.setValue(garage, feature(garage, 'enabled'), 1);
  assert.match(gone.error, /no longer in Surveillance Station/);
});

test('a refused password: no retry alone, even on reconnection; saving the configuration tries again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'syno-app-'));
  const nas = createFakeNas();
  const { gladys, timers, app } = await setup({ nas, dataDir, config: { password: 'wrong' } });
  assert.equal(nas.logins.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name or password/);
  assert.equal(timers.pending.size, 0, 'no timer: nothing tried again');

  await app.start(await gladys.getConfig()); // what a reconnection to Gladys does
  assert.equal(nas.logins.length, 1);
  await app.stop();

  // A restart of the container: the refusal is remembered in /data.
  const second = await setup({ nas, dataDir, config: { password: 'wrong' } });
  assert.equal(nas.logins.length, 1);
  assert.match(second.gladys.fake.connectionStatus.message.en, /refused/);

  // The user saves the configuration (same values): tried once.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'wrong' });
  assert.equal(nas.logins.length, 2);
  // The button too.
  const ack = await second.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(nas.logins.length, 3);
  // Fixed.
  await second.gladys.fake.configUpdated(BASE_CONFIG);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  const test2 = await second.gladys.fake.action(ACTIONS.TEST);
  assert.equal(test2.success, true);
  assert.match(test2.data.message.en, /Connected: 3 cameras \(Garden, Entrée, Garage\)/);
});

test('2-step verification asked: a clear status, no retry', async () => {
  const nas = createFakeNas({ otp: '123456' });
  const { gladys, timers } = await setup({ nas });
  assert.match(gladys.fake.connectionStatus.message.en, /2-step verification/);
  assert.equal(timers.pending.size, 0);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, otp_code: '123 456' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a NAS that does not answer: badges unreachable, retries 30 s, 60 s..., then back', async () => {
  const { gladys, nas, timers } = await setup();
  nas.down = CODES.UNREACHABLE;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer: no connection/);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(timers.delays(), [30_000]);
  await timers.run();
  assert.deepEqual(timers.delays(), [60_000]);
  nas.down = null;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
});

test('invalid configurations: a status, no request', async () => {
  const nas = createFakeNas();
  const { gladys } = await setup({ nas, config: { url: 'https://admin:x@nas' } });
  assert.match(gladys.fake.connectionStatus.message.en, /Remove the user name/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: '' });
  assert.match(gladys.fake.connectionStatus.message.en, /Type the user name and password/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, otp_code: '12' });
  assert.match(gladys.fake.connectionStatus.message.en, /6 digits/);
  assert.equal(nas.requests.length, 0);
});

test('trust the new certificate: only with the option on', async () => {
  const { gladys } = await setup();
  const refused = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.equal(refused.success, false);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, allow_self_signed: true });
  const ok = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.equal(ok.success, true);
});

test('no secret in the logs', async () => {
  const nas = createFakeNas({ otp: '123456' });
  const { logs, gladys, timers } = await setup({ nas, config: { otp_code: '123456' } });
  nas.down = CODES.TIMEOUT;
  await timers.run((ms) => ms === INTERVALS.STATUS_MS);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other' });
  const text = logs.join('\n');
  for (const secret of ['s3cret', '123456', 'sid-', 'device-token', 'other']) {
    assert.ok(!text.includes(secret), `"${secret}" logged`);
  }
});
