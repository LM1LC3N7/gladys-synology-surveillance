// -----------------------------------------------------------------------------
// SurveillanceApp: the integration. One NAS, its Surveillance Station.
//
//   start(config)  (re)connects: login, cameras and Home Mode read, Discovery
//                  published, loops started
//   status loop    every minute: cameras (enabled, reachable) and Home Mode;
//                  while the NAS fails, the reconnection, 30 s to 10 min
//                  (HTTP 429: a pause of 1 min to 6 h, Retry-After honoured)
//   event loop     every `event_interval` s: the recent events (recordings)
//                  -> motion sensor per camera and `motion_detected`
//   image loop     every `image_refresh` s: one snapshot per created camera
//                  pushed to Gladys (60 KB, 150 KB when it never fits)
//   getImage       onGetImage: a fresh snapshot (150 KB, 14 s in all)
//   setValue       camera enabled / Home Mode, see "Commands" below
//
// Each loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch (still in flight when the NAS failed) never schedules itself
// again. A refused login is final (src/synology/client.js): every loop stops
// and the status says what to fix; nothing logs in again until the
// configuration is saved or "Test the connection" is pressed.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CAMERA_UNREACHABLE_STATUSES,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  EVENT_PAGE,
  FEATURES,
  IMAGE_PREFIX,
  INTERVALS,
  MAX_IMAGE_LENGTH,
  MAX_SEEN_EVENTS,
  MAX_STORED_IMAGE_LENGTH,
  MOTION_HOLD_MS,
  MOTION_MAX_AGE_S,
  MOTION_REASONS,
  MOTION_REASON_NAMES,
  SCENE_TRIGGERS,
  SNAPSHOT_PROFILES,
  STORE_FILE,
  TIMEOUTS,
} from './constants.js';
import {
  buildCameraDevice,
  buildStationDevice,
  cameraIds,
  createdDevices,
  parseExternalId,
  stationIds,
} from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { SynologyClient } from './synology/client.js';
import { CODES, SynologyError, isFinalAuthError } from './synology/errors.js';
import { httpRequest } from './synology/http.js';

/** Events older than this (NAS clock) are not asked for. */
const EVENT_WINDOW_S = 15 * 60;
const MAX_LISTED_NAMES = 10;
/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;

const toGladysImage = (jpeg) => `${IMAGE_PREFIX}${jpeg.toString('base64')}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class SurveillanceApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake NAS)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'synology-surveillance' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    this.commands = Promise.resolve();
    this.activeCommands = 0;
    this.stateVersion = 0;
    this.lastStatus = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.cameras = new Map(); // id -> { id, name, enabled (true/false/null), status, model }
    this.hasHomeMode = false;
    this.homeMode = null;
    this.motionUntil = new Map(); // camera id -> ms
    this.seenEvents = new Set();
    this.eventsArmed = false;
    this.motionMark = null; // { start, key } of the last motion event processed
    this.transports = new Map(); // device external id -> transport
    this.inFlightImages = new Map();
    this.bigImageWarned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration), a login refused earlier with the
   * same values is tried.
   */
  start(rawConfig, { force = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  /** The values a login refusal is about (HMAC with the salt of /data: never the password). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.nas.origin, config.username, config.password, config.otpCode]))
      .digest('hex');
  }

  accountKey(config) {
    return `${config.nas.origin}|${config.username}`;
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    const client = this.client;
    this.client = null;
    if (client) {
      client
        .logout()
        .catch(() => {})
        .finally(() => client.close());
    }
  }

  async run(rawConfig, { force = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    await this.store.load();

    if (config.urlError) {
      const message = { empty: T.status.urlEmpty, credentials: T.status.urlCredentials }[
        config.urlError
      ];
      await this.setStatus(false, message ?? T.status.urlInvalid);
      return;
    }
    if (!config.username || !config.password) {
      await this.setStatus(false, T.status.missingCredentials);
      return;
    }
    if (config.otpInvalid) {
      await this.setStatus(false, T.status.otpInvalid);
      return;
    }
    // A login DSM refused with these very values is not tried again alone.
    const refused = this.store.get('refusals', this.accountKey(config));
    const [refusedKey, refusedCode] = String(refused ?? '').split(':');
    if (refused && refusedKey === (await this.refusalKey(config)) && !force) {
      this.blocked = true;
      this.logger.warn('Login refused earlier with the same values: not tried again');
      await this.setStatus(false, T.refusal({ apiCode: Number(refusedCode) }));
      return;
    }
    if (refused) await this.store.set('refusals', this.accountKey(config), null);
    this.motionMark = this.readMotionMark();
    this.client = new SynologyClient({
      nas: config.nas,
      username: config.username,
      password: config.password,
      otpCode: config.otpCode,
      allowSelfSigned: config.allowSelfSigned,
      store: this.store,
      request: this.request,
      now: this.now,
    });
    this.logger.info(`Using the NAS at ${config.nas.origin}`);
    await this.connect(generation);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** Schedule one step of a loop of the current epoch. */
  scheduleLoop(delay, loop, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => loop.call(this, generation, epoch));
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** Login, first reading, loops. Never throws. */
  async connect(generation) {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      // The first authenticated request logs in (once: the session is kept).
      this.hasHomeMode = await client.hasHomeMode();
      // A reading crossed by a command is dropped: read again (bounded).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await this.refreshStatus({ publish: true })) break;
      }
      if (generation !== this.generation) return;
      this.logger.info(`Surveillance Station answers: ${this.cameras.size} camera(s)`);
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(INTERVALS.STATUS_MS, this.statusLoop, generation);
    this.scheduleLoop(1_000, this.eventLoop, generation);
    if (this.config.imageSeconds > 0) this.scheduleLoop(2_000, this.imageLoop, generation);
  }

  /** A reading failed: final refusal, or retry with a growing delay. */
  async failed(err, generation) {
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishCameraTransports();
    if (isFinalAuthError(err)) {
      this.blocked = true;
      await this.store.set(
        'refusals',
        this.accountKey(this.config),
        `${await this.refusalKey(this.config)}:${err.apiCode}`,
      );
      this.logger.warn(
        `Login refused by DSM (${err.apiCode}): not retried until the configuration changes`,
      );
      await this.setStatus(false, T.refusal(err));
      return;
    }
    let delay;
    if (err.status === 429) {
      // Too many requests: a bounded pause of every path (loops, commands, images).
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MAX_MS,
      );
      this.pausedUntil = this.now() + delay;
    } else {
      delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
      if (err.status >= 500 && err.retryAfterMs) {
        delay = clamp(err.retryAfterMs, delay, INTERVALS.BUSY_MAX_MS);
        this.pausedUntil = this.now() + delay;
      }
    }
    if (wasOnline || delay === INTERVALS.RETRY_MIN_MS) {
      this.logger.warn(`The NAS fails: ${err.message}`);
    }
    await this.setStatus(false, this.errorMessage(err, delay));
    this.schedule(delay, () => this.connect(generation));
  }

  errorMessage(err, delay) {
    if (err.code === CODES.TLS_UNTRUSTED) return T.status.tlsUntrusted(delay);
    if (err.code === CODES.TLS_CHANGED) return T.status.tlsChanged(delay);
    if (err.status === 429) return T.status.busy(delay);
    if (err.status >= 500) return T.status.serverError(err.status, delay);
    if (err.code === CODES.BAD_ANSWER || err.code === CODES.HTTP) {
      return T.status.notSynology(delay);
    }
    if (err.code === CODES.NO_API) return T.status.noSurveillance(delay);
    if (err.code === CODES.API && (err.apiCode === 105 || err.apiCode === 160)) {
      return T.status.privilege;
    }
    if (err.code === CODES.API && err.apiCode === 102) return T.status.noSurveillance(delay);
    return T.status.unreachable(err, delay);
  }

  /** Errors of the event and image loops that stop everything. */
  async stopsLoops(err, generation) {
    if (isFinalAuthError(err) || err?.status === 429) {
      await this.failed(err, generation);
      return true;
    }
    return false;
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Status: cameras and Home Mode -----------------------------------------

  async statusLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    try {
      await this.refreshStatus({ publish: false });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) {
      this.scheduleLoop(INTERVALS.STATUS_MS, this.statusLoop, generation);
    }
  }

  /**
   * Read the cameras and Home Mode, publish them. Resolves false when the
   * reading was dropped: a command ran meanwhile (its result is newer).
   */
  async refreshStatus({ publish }) {
    const client = this.client;
    if (!client) return true;
    const version = this.stateVersion;
    const cameras = await client.listCameras();
    const homeMode = this.hasHomeMode ? await client.homeMode() : null;
    if (client !== this.client) return true;
    if (version !== this.stateVersion || this.activeCommands > 0) return false;
    const before = [...this.cameras.values()].map((c) => `${c.id}|${c.name}`).join(',');
    this.cameras = new Map(cameras.map((camera) => [camera.id, camera]));
    const after = cameras.map((c) => `${c.id}|${c.name}`).join(',');
    this.online = true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    if (publish || before !== after) await this.publishDiscovered();
    await this.observeHomeMode(homeMode);
    await this.publishStatusStates();
    await this.publishCameraTransports();
    await this.setStatus(true, T.status.ok({ count: cameras.length, homeMode: this.homeMode }));
    return true;
  }

  /** Home Mode read: keep it, and fire the trigger on a change (not the first reading). */
  async observeHomeMode(value) {
    if (value === null || value === undefined) return;
    const previous = this.homeMode;
    this.homeMode = value;
    if (previous !== null && previous !== value) {
      await this.sceneEvent(SCENE_TRIGGERS.HOME_MODE, { state: value ? 'on' : 'off' });
    }
  }

  /** Never throws: a refusal of Gladys is not a NAS failure. */
  async publishDiscovered() {
    const devices = [...this.cameras.values()].map((camera) =>
      buildCameraDevice(this.gladys, camera),
    );
    if (this.hasHomeMode) devices.unshift(buildStationDevice(this.gladys));
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.online && !this.paused()) {
      const applied = await this.refreshStatus({ publish: true }).catch(() => false);
      if (applied) return;
    }
    await this.publishDiscovered();
  }

  statusStates() {
    const created = createdDevices(this.gladys);
    const states = [];
    for (const { id } of created.cameras) {
      const enabled = this.cameras.get(id)?.enabled;
      if (typeof enabled !== 'boolean') continue; // unknown: nothing published
      states.push({
        device_feature_external_id: cameraIds(this.gladys, id).feature(FEATURES.ENABLED),
        state: enabled ? 1 : 0,
      });
    }
    if (created.station && this.homeMode !== null) {
      states.push({
        device_feature_external_id: stationIds(this.gladys).feature(FEATURES.HOME_MODE),
        state: this.homeMode ? 1 : 0,
      });
    }
    return states;
  }

  async publishStates(states) {
    if (states.length === 0) return;
    await this.gladys.publishChangedStates(states).catch((err) => {
      this.logger.warn(`States not published: ${err.message}`);
    });
  }

  async publishStatusStates() {
    await this.publishStates(this.statusStates());
  }

  async publishCameraTransports() {
    const entries = [];
    const created = createdDevices(this.gladys);
    for (const { id, externalId } of created.cameras) {
      const camera = this.cameras.get(id);
      const reachable =
        this.online && camera && !CAMERA_UNREACHABLE_STATUSES.includes(camera.status ?? -1);
      entries.push({ external_id: externalId, transport: reachable ? 'local' : 'unreachable' });
    }
    if (created.station) {
      entries.push({
        external_id: stationIds(this.gladys).device,
        transport: this.online ? 'local' : 'unreachable',
      });
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    for (const entry of changed) this.transports.set(entry.external_id, entry.transport);
    await this.gladys.publishTransports(changed).catch((err) => {
      for (const entry of changed) this.transports.delete(entry.external_id);
      this.logger.debug(`Transports not published: ${err.message}`);
    });
  }

  async sceneEvent(key, data) {
    await this.gladys.publishSceneEvent(key, data).catch((err) => {
      this.logger.warn(`Scene event ${key} not sent: ${err.message}`);
    });
  }

  // --- Events: motion --------------------------------------------------------
  //
  // An event fires `motion_detected` once (its key is remembered), when it
  // ended (or is still running) less than 2 minutes ago: the events of a NAS
  // outage are marked as seen without a burst of old triggers. After a start
  // (or a reconnection to Gladys), the mark kept in /data tells which events
  // were already processed: the newer ones still fire, within the same 2
  // minutes. Without any mark (first start), recent events fire too.

  async eventLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.online) {
      try {
        await this.pollEvents();
      } catch (err) {
        if (!this.current(generation, epoch)) return;
        if (await this.stopsLoops(err, generation)) return;
        // The status loop owns the connection state.
        this.logger.debug(`Events not read: ${err.message}`);
      }
    }
    if (this.current(generation, epoch)) {
      this.scheduleLoop(this.config.eventSeconds * 1000, this.eventLoop, generation);
    }
  }

  readMotionMark() {
    const raw = this.store.get('motionMarks', this.config.nas.origin);
    const [start, key] = String(raw ?? '').split('|');
    const number = Number(start);
    return raw && key && Number.isFinite(number) ? { start: number, key } : null;
  }

  async pollEvents() {
    const client = this.client;
    if (!client) return;
    const nowS = Math.floor(this.now() / 1000);
    const events = await client.events({ fromTime: nowS - EVENT_WINDOW_S, limit: EVENT_PAGE });
    if (client !== this.client) return;
    const time = this.now();
    const mark = this.motionMark;
    let newest = mark;
    // Oldest first: the triggers fire in the order things happened.
    for (const event of [...events].sort((a, b) => a.start - b.start)) {
      if (!MOTION_REASONS.includes(event.reason)) continue;
      const isNew = !this.seenEvents.has(event.key);
      if (isNew) this.remember(event.key);
      if (!newest || event.start >= newest.start) newest = { start: event.start, key: event.key };
      const lastActive = event.ongoing ? nowS : (event.stop ?? event.start);
      const recent = lastActive >= nowS - MOTION_MAX_AGE_S;
      const afterMark =
        !mark || event.start > mark.start || (event.start === mark.start && event.key !== mark.key);
      const camera = this.cameras.get(event.cameraId);
      const fire = isNew && recent && (this.eventsArmed || afterMark);
      if (event.ongoing || fire) this.motionUntil.set(event.cameraId, time + MOTION_HOLD_MS);
      if (fire && camera) {
        await this.sceneEvent(SCENE_TRIGGERS.MOTION, {
          camera: cameraIds(this.gladys, camera.id).device,
          camera_name: camera.name,
          reason: MOTION_REASON_NAMES[event.reason],
        });
      }
    }
    this.eventsArmed = true;
    if (newest && (newest.start !== mark?.start || newest.key !== mark?.key)) {
      this.motionMark = newest;
      await this.store.set('motionMarks', this.config.nas.origin, `${newest.start}|${newest.key}`);
    }
    const states = createdDevices(this.gladys).cameras.map(({ id }) => ({
      device_feature_external_id: cameraIds(this.gladys, id).feature(FEATURES.MOTION),
      state: (this.motionUntil.get(id) ?? 0) > time ? 1 : 0,
    }));
    await this.publishStates(states);
  }

  remember(key) {
    this.seenEvents.add(key);
    if (this.seenEvents.size > MAX_SEEN_EVENTS) {
      this.seenEvents.delete(this.seenEvents.values().next().value);
    }
  }

  // --- Images ----------------------------------------------------------------

  /**
   * A snapshot under `maxLength` (the whole `image/jpg;base64,` string): the
   * "balanced" profile first, then "low bandwidth". Shared while running.
   */
  fitImage(id, maxLength, { deadline } = {}) {
    const key = `${id}|${maxLength}`;
    const running = this.inFlightImages.get(key);
    if (running) return running;
    const promise = (async () => {
      const client = this.client;
      if (!client) throw new Error(T.errors.notConnected);
      for (const profile of [SNAPSHOT_PROFILES.BALANCED, SNAPSHOT_PROFILES.LOW]) {
        const image = toGladysImage(await client.snapshot(id, { profile, deadline }));
        if (image.length <= maxLength) return image;
      }
      throw new SynologyError(CODES.IMAGE_TOO_LARGE, 'Snapshot too large at every profile');
    })().finally(() => this.inFlightImages.delete(key));
    this.inFlightImages.set(key, promise);
    return promise;
  }

  /** onGetImage: a fresh snapshot (150 KB), within 14 s for every request. */
  async getImage(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (parsed?.kind !== 'camera' || parsed.feature !== null) {
      throw new Error(T.errors.unknownDevice);
    }
    if (!this.client || !this.online) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const camera = this.cameras.get(parsed.id);
    // Unknown (null): tried anyway.
    if (camera?.enabled === false) throw new Error(T.errors.cameraDisabled);
    try {
      return await this.fitImage(parsed.id, MAX_IMAGE_LENGTH, {
        deadline: this.now() + TIMEOUTS.LIVE_IMAGE,
      });
    } catch (err) {
      throw new Error(T.errors.image(camera?.name ?? device.name ?? parsed.id, err), {
        cause: err,
      });
    }
  }

  async imageLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.online) await this.pushImages(generation, epoch);
    if (this.current(generation, epoch)) {
      this.scheduleLoop(this.config.imageSeconds * 1000, this.imageLoop, generation);
    }
  }

  /** The image pushed to Gladys: 60 KB, else up to 150 KB (warned once per camera). */
  async storedImage(id) {
    try {
      return await this.fitImage(id, MAX_STORED_IMAGE_LENGTH);
    } catch (err) {
      if (err.code !== CODES.IMAGE_TOO_LARGE) throw err;
      if (!this.bigImageWarned.has(id)) {
        this.bigImageWarned.add(id);
        this.logger.warn(
          `Camera ${id}: no snapshot under 60 KB, the dashboard image goes up to 150 KB`,
        );
      }
      return this.fitImage(id, MAX_IMAGE_LENGTH);
    }
  }

  /** One snapshot per created camera not disabled, in turn. */
  async pushImages(generation, epoch) {
    for (const { id, externalId } of createdDevices(this.gladys).cameras) {
      if (!this.current(generation, epoch) || !this.online) return;
      if (this.cameras.get(id)?.enabled === false) continue;
      try {
        const image = await this.storedImage(id);
        await this.gladys.publishCameraImage(externalId, image).catch((err) => {
          this.logger.debug(`Image of camera ${id} not published: ${err.message}`);
        });
      } catch (err) {
        if (!this.current(generation, epoch)) return;
        if (await this.stopsLoops(err, generation)) return;
        this.logger.debug(`No image of camera ${id}: ${err.message}`);
      }
    }
  }

  // --- Commands --------------------------------------------------------------
  //
  // Disabling a camera or turning Home Mode on reduces the surveillance: both
  // are refused unless the user allowed them (`allow_camera_control`, off by
  // default), checked when the command arrives AND just before it is sent.
  // Enabling a camera and leaving Home Mode (more surveillance) are always
  // allowed. Every command goes through one queue (one at a time), uses the
  // client of the moment it arrived (a new configuration in between refuses
  // it), and reads the current state from the NAS just before acting: an
  // unknown state refuses the command; the state already there sends
  // nothing. Gladys waits 5 s: past 3.5 s after the command arrived, nothing
  // is sent any more. A status reading crossed by a command is dropped.

  async setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    const isCamera = parsed?.kind === 'camera' && parsed.feature === FEATURES.ENABLED;
    const isHomeMode = parsed?.kind === 'station' && parsed.feature === FEATURES.HOME_MODE;
    if (!isCamera && !isHomeMode) throw new Error(T.errors.unknownDevice);
    const number = Number(value);
    if (number !== 0 && number !== 1) throw new Error(T.errors.invalidValue);
    const target = number === 1;
    const reduces = isCamera ? !target : target;
    if (reduces && !this.config.allowControl) throw new Error(T.errors.controlDisabled);
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const generation = this.generation;

    const run = this.commands.then(() =>
      this.command(received, {
        client,
        generation,
        reduces,
        target,
        read: (options) =>
          isCamera ? this.readCameraEnabled(client, parsed.id, options) : client.homeMode(options),
        send: (options) =>
          isCamera
            ? client.setCameraEnabled(parsed.id, target, options)
            : client.setHomeMode(target, options),
        done: () =>
          isCamera
            ? this.cameraCommanded(parsed.id, target)
            : this.observeHomeMode(target).then(() => this.publishStatusStates()),
      }),
    );
    this.commands = run.catch(() => {});
    return run;
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation, reduces }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new Error(T.errors.configChanged);
    }
    if (reduces && !this.config.allowControl) throw new Error(T.errors.controlDisabled);
    if (this.paused()) throw new Error(T.errors.busy);
  }

  async command(received, { client, generation, reduces, read, send, target, done }) {
    this.activeCommands += 1;
    this.stateVersion += 1;
    try {
      this.stillValid({ client, generation, reduces });
      const deadline = received + COMMAND_BUDGET_MS;
      if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
      let current;
      try {
        current = await read({ deadline: deadline - COMMAND_MIN_SEND_MS });
      } catch (err) {
        if (err.message === T.errors.unknownCamera) throw err;
        throw new Error(T.errors.unknownState(err), { cause: err });
      }
      if (typeof current !== 'boolean') throw new Error(T.errors.unknownState({}));
      if (current === target) {
        this.stillValid({ client, generation, reduces: false });
        await done();
        return;
      }
      if (deadline - this.now() < COMMAND_MIN_SEND_MS) throw new Error(T.errors.tooSlow);
      // The last check before acting: the user may have changed things meanwhile.
      this.stillValid({ client, generation, reduces });
      try {
        await send({ deadline });
      } catch (err) {
        if (err.notSent) throw new Error(T.errors.notSent(err), { cause: err });
        if (err.code === CODES.API) throw new Error(T.errors.refused(err), { cause: err });
        // Sent, no answer: nobody knows. Read the truth again soon.
        this.schedule(2_000, () => this.refreshStatus({ publish: false }).catch(() => {}));
        throw new Error(T.errors.noConfirmation(err), { cause: err });
      }
      await done();
    } finally {
      this.stateVersion += 1;
      this.activeCommands -= 1;
    }
  }

  async readCameraEnabled(client, id, options) {
    const cameras = await client.listCameras(options);
    const camera = cameras.find((c) => c.id === id);
    if (!camera) throw new Error(T.errors.unknownCamera);
    if (client === this.client) this.cameras.set(id, camera);
    if (typeof camera.enabled !== 'boolean') {
      throw new SynologyError(CODES.BAD_ANSWER, 'No enabled state for this camera');
    }
    return camera.enabled;
  }

  async cameraCommanded(id, enabled) {
    const camera = this.cameras.get(id);
    if (camera) this.cameras.set(id, { ...camera, enabled });
    await this.publishStatusStates();
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || !this.online) return;
    await this.publishStatusStates();
    await this.publishCameraTransports();
    if (
      parsed.kind === 'camera' &&
      this.config.imageSeconds > 0 &&
      !this.paused() &&
      this.cameras.get(parsed.id)?.enabled !== false
    ) {
      // The new camera gets its first image now, not at the next round.
      const image = await this.storedImage(parsed.id).catch(() => null);
      if (image) await this.gladys.publishCameraImage(device.external_id, image).catch(() => {});
    }
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration buttons -------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused login included: the user asked), then reports, within 25 s. */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { force: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    const cameras = [...this.cameras.values()];
    const names =
      cameras
        .slice(0, MAX_LISTED_NAMES)
        .map((c) => c.name)
        .join(', ') + (cameras.length > MAX_LISTED_NAMES ? '…' : '');
    return T.test.ok({ count: cameras.length, names });
  }

  /** Forget the pinned certificate and reconnect (the new one gets pinned), in the start queue. */
  async trustNewCertificate() {
    if (!this.config.allowSelfSigned || !this.config.nas) throw new Error(T.errors.selfSignedOff);
    await this.within(
      this.enqueue(async () => {
        const { nas } = this.config;
        await this.store.load();
        await this.store.set('tlsPins', `${nas.hostname}:${nas.port}`, null);
        await this.run(this.rawConfig, { force: true });
      }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    return T.test.trusted;
  }
}
