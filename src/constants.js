// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
  TRUST_CERTIFICATE: 'trust_new_certificate',
});

export const SCENE_TRIGGERS = Object.freeze({
  MOTION: 'motion_detected',
  HOME_MODE: 'home_mode_changed',
});

/** Device external ids: `ext:<selector>:camera:<Surveillance Station camera id>`. */
export const CAMERA_TYPE = 'camera';
/** The station itself (Home Mode): one per integration, `ext:<selector>:station:main`. */
export const STATION_TYPE = 'station';
export const STATION_ID = 'main';

export const FEATURES = Object.freeze({
  IMAGE: 'image',
  ENABLED: 'enabled',
  MOTION: 'motion',
  HOME_MODE: 'home_mode',
});

/** Seconds between two event reads (motion). */
export const EVENT_INTERVALS = Object.freeze(['5', '10', '30', '60']);
/** Seconds between two images pushed to the dashboard; '0' pushes none. */
export const IMAGE_INTERVALS = Object.freeze(['0', '30', '60', '300', '600']);

// The Web API of DSM. The versions are the highest this code was written for;
// the NAS says which it supports (SYNO.API.Info) and the lower one is used.
export const API = Object.freeze({
  INFO: 'SYNO.API.Info',
  AUTH: 'SYNO.API.Auth',
  SS_INFO: 'SYNO.SurveillanceStation.Info',
  CAMERA: 'SYNO.SurveillanceStation.Camera',
  HOME_MODE: 'SYNO.SurveillanceStation.HomeMode',
  EVENT: 'SYNO.SurveillanceStation.Event',
  RECORDING: 'SYNO.SurveillanceStation.Recording',
});

export const PREFERRED_VERSIONS = Object.freeze({
  [API.AUTH]: 6, // 6: device token (2-step verification remembered)
  [API.SS_INFO]: 8,
  [API.CAMERA]: 9,
  [API.HOME_MODE]: 1,
  [API.EVENT]: 5,
  [API.RECORDING]: 6,
});

/** Snapshot profiles of Camera.GetSnapshot (py-synologydsm-api const.py). */
export const SNAPSHOT_PROFILES = Object.freeze({ HIGH: 0, BALANCED: 1, LOW: 2 });

/**
 * Event (recording) reasons that mean "something moved". 2 is the motion
 * detection of Surveillance Station or of the camera; 7 the video analytics
 * (DVA, intrusion...). Never checked against a real NAS: see TODO.md.
 */
export const MOTION_REASONS = Object.freeze([2, 7]);
export const MOTION_REASON_NAMES = Object.freeze({ 2: 'motion', 7: 'analytics' });

/**
 * Camera `status` of Camera.List that mean "Surveillance Station cannot reach
 * the camera" (3 disconnected, 4 unavailable, 6 inaccessible, 10 server
 * disconnected, 15 connection failed, 16 unauthorized, 17 RTSP error, 18 no
 * video). Not checked against a real NAS: see TODO.md.
 */
export const CAMERA_UNREACHABLE_STATUSES = Object.freeze([3, 4, 6, 10, 15, 16, 17, 18]);

// Gladys camera images: `image/jpg;base64,...`, the whole string counted.
export const IMAGE_PREFIX = 'image/jpg;base64,';
/** onGetImage (live view, "send a camera image"): the core limit. */
export const MAX_IMAGE_LENGTH = 150 * 1024;
/** The image pushed to the device is stored by Gladys: kept small (see gladys-go2rtc). */
export const MAX_STORED_IMAGE_LENGTH = 60 * 1024;
export const MAX_PUSHES_PER_MINUTE = 12;

export const TIMEOUTS = Object.freeze({
  API: 8_000,
  LOGIN: 10_000,
  SNAPSHOT: 12_000, // onGetImage: Gladys waits 15 s
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent to the NAS
 * (an action must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command request itself. */
export const COMMAND_MIN_SEND_MS = 1_000;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_500;

export const INTERVALS = Object.freeze({
  STATUS_MS: 60_000, // cameras (enabled, status) and Home Mode
  RETRY_MIN_MS: 30_000, // NAS unreachable: first retry
  RETRY_MAX_MS: 10 * 60_000,
  /** A session refused again this soon after a login is not renewed again. */
  MIN_LOGIN_GAP_MS: 30_000,
});

/** A motion event counts as current this long after it stopped. */
export const MOTION_HOLD_MS = 30_000;
/** Events read in one request (newest first). */
export const EVENT_PAGE = 50;
/** Event ids remembered to fire each event once. */
export const MAX_SEEN_EVENTS = 500;

/** Size caps of the answers read from the NAS. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_JPEG_BYTES = 8 * 1024 * 1024;

/** The persistent store (device token of the 2-step verification, TLS pin). */
export const STORE_FILE = 'synology-surveillance.json';
