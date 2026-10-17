// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   camera   `ext:<selector>:camera:<id>`   one per Surveillance Station camera,
//            the id Surveillance Station gives it (stable, never reused for
//            another camera while it exists): image, enabled, motion
//   station  `ext:<selector>:station:main`  the Home Mode of the NAS
//
// One NAS per integration: the station id is a constant.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { CAMERA_TYPE, FEATURES, STATION_ID, STATION_TYPE } from './constants.js';

export const cameraIds = (gladys, id) => gladys.externalIds(CAMERA_TYPE, String(id));
export const stationIds = (gladys) => gladys.externalIds(STATION_TYPE, STATION_ID);

const binary = (category, type, extra) => ({
  category,
  type,
  min: 0,
  max: 1,
  keep_history: true,
  ...extra,
});

export function buildCameraDevice(gladys, camera) {
  const ids = cameraIds(gladys, camera.id);
  return {
    name: camera.name,
    external_id: ids.device,
    model: camera.model ?? 'Surveillance Station camera',
    should_poll: false,
    features: [
      {
        name: 'Image',
        external_id: ids.feature(FEATURES.IMAGE),
        category: DEVICE_FEATURE_CATEGORIES.CAMERA,
        type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: 'Enabled in Surveillance Station',
        external_id: ids.feature(FEATURES.ENABLED),
        // The core's camera on/off feature (like gladys-frigate): mapped to
        // Enable / Disable of the camera in Surveillance Station.
        ...binary(DEVICE_FEATURE_CATEGORIES.CAMERA, DEVICE_FEATURE_TYPES.CAMERA.ENABLED, {
          read_only: false,
          has_feedback: true,
        }),
      },
      {
        name: 'Motion',
        external_id: ids.feature(FEATURES.MOTION),
        ...binary(DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR, DEVICE_FEATURE_TYPES.SENSOR.BINARY, {
          read_only: true,
          has_feedback: false,
        }),
      },
    ],
  };
}

export function buildStationDevice(gladys, { name } = {}) {
  const ids = stationIds(gladys);
  return {
    name: name || 'Surveillance Station',
    external_id: ids.device,
    model: 'Synology Surveillance Station',
    should_poll: false,
    features: [
      {
        name: 'Home Mode',
        external_id: ids.feature(FEATURES.HOME_MODE),
        ...binary(DEVICE_FEATURE_CATEGORIES.SWITCH, DEVICE_FEATURE_TYPES.SWITCH.BINARY, {
          read_only: false,
          has_feedback: true,
        }),
      },
    ],
  };
}

/**
 * What a device or feature external id of this integration designates:
 * { kind: 'camera', id, feature? } | { kind: 'station', feature? } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const cameraPrefix = gladys.externalId(`${CAMERA_TYPE}:`);
  if (externalId.startsWith(cameraPrefix)) {
    const [id, feature, ...rest] = externalId.slice(cameraPrefix.length).split(':');
    if (rest.length > 0 || !/^\d+$/.test(id ?? '')) return null;
    return { kind: 'camera', id: Number(id), feature: feature ?? null };
  }
  const stationDevice = gladys.externalId(`${STATION_TYPE}:${STATION_ID}`);
  if (externalId === stationDevice) return { kind: 'station', feature: null };
  if (externalId.startsWith(`${stationDevice}:`)) {
    const feature = externalId.slice(stationDevice.length + 1);
    return feature.includes(':') ? null : { kind: 'station', feature };
  }
  return null;
}

/** The created devices of this integration: { cameras: [{ externalId, id }], station: bool }. */
export function createdDevices(gladys, devices = gladys.devices) {
  const cameras = [];
  let station = false;
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (parsed?.kind === 'camera' && parsed.feature === null) {
      cameras.push({ externalId: device.external_id, id: parsed.id, name: device.name });
    } else if (parsed?.kind === 'station' && parsed.feature === null) {
      station = true;
    }
  }
  return { cameras: cameras.sort((a, b) => a.id - b.id), station };
}
