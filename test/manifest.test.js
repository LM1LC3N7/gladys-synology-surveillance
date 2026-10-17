// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  EVENT_INTERVALS,
  IMAGE_INTERVALS,
  MOTION_REASON_NAMES,
  SCENE_TRIGGERS,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const byKey = (list, key) => list.find((item) => item.key === key);
const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/, 'scene triggers need 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-synology-surveillance:${manifest.version}`,
  );
  assert.equal(pkg.name, 'gladys-synology-surveillance');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(manifest.location, undefined, 'no house location needed');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
});

test('the license and the notices ship in the image', () => {
  assert.match(read('LICENSE'), /Apache License/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /py-synologydsm-api[\s\S]*MIT License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.event_interval.options.map((o) => o.value),
    EVENT_INTERVALS,
  );
  assert.deepEqual(
    fields.image_refresh.options.map((o) => o.value),
    IMAGE_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'url',
    'username',
    'password',
    'otp_code',
    'allow_self_signed',
    'security_section',
    'allow_camera_control',
    'polling_section',
    'event_interval',
    'image_refresh',
  ]);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.otp_code.type, 'secret', 'a 2-step verification code is a credential');
  assert.match(fields.url.description.en, /in clear/, 'the risk of http is said');
  assert.match(fields.url.description.fr, /en clair/);
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted/i, 'a secret is not encrypted');
  // Safety: reducing the surveillance is off unless the user allows it.
  assert.equal(fields.allow_camera_control.type, 'boolean');
  assert.equal(fields.allow_camera_control.default, false);
  assert.equal(fields.allow_self_signed.default, false);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.ok(app.includes(`SCENE_TRIGGERS.${name}`), `${name} is never fired`);
  }
  for (const handler of ['onGetImage(', 'onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('the triggers: filters and variables are keys of the events', () => {
  const motion = byKey(manifest.scene_triggers, SCENE_TRIGGERS.MOTION);
  assert.deepEqual(
    byKey(motion.fields, 'reason').options.map((o) => o.value),
    Object.values(MOTION_REASON_NAMES),
  );
  const home = byKey(manifest.scene_triggers, SCENE_TRIGGERS.HOME_MODE);
  assert.deepEqual(
    byKey(home.fields, 'state').options.map((o) => o.value),
    ['on', 'off'],
  );
  // The data the app sends (test/app.test.js checks the real events).
  const data = {
    [SCENE_TRIGGERS.MOTION]: ['camera', 'camera_name', 'reason'],
    [SCENE_TRIGGERS.HOME_MODE]: ['state'],
  };
  for (const trigger of manifest.scene_triggers) {
    for (const key of keys([...trigger.fields, ...trigger.variables])) {
      assert.ok(data[trigger.key].includes(key), `${trigger.key}.${key} is not in the event`);
    }
    const camera = byKey(trigger.fields, 'camera');
    if (camera) {
      assert.equal(camera.source, 'devices');
      assert.equal(camera.options, undefined);
    }
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});
