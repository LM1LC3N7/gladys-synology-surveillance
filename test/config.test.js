import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, parseNasUrl, parseOtp } from '../src/config.js';

test('the NAS address: https by default, DSM ports, nothing but an origin', () => {
  assert.deepEqual(parseNasUrl('192.168.1.10'), {
    origin: 'https://192.168.1.10:5001',
    protocol: 'https:',
    hostname: '192.168.1.10',
    port: 5001,
  });
  assert.equal(parseNasUrl('http://NAS.local').origin, 'http://nas.local:5000');
  assert.equal(parseNasUrl('https://nas.local:8443/').origin, 'https://nas.local:8443');
  assert.equal(parseNasUrl('nas.local:5000').origin, 'https://nas.local:5000');
  assert.equal(parseNasUrl('https://[fd00::10]:5001').origin, 'https://[fd00::10]:5001');
  assert.deepEqual(parseNasUrl(''), { error: 'empty' });
  assert.deepEqual(parseNasUrl('https://admin:pw@nas:5001'), { error: 'credentials' });
  assert.deepEqual(parseNasUrl('https://nas:5001/webapi'), { error: 'invalid' });
  assert.deepEqual(parseNasUrl('https://nas:5001/?a=1'), { error: 'invalid' });
  assert.deepEqual(parseNasUrl('ftp://nas'), { error: 'invalid' });
  assert.deepEqual(parseNasUrl('http://'), { error: 'invalid' });
});

test('the 2-step verification code: 6 digits, spaces ignored', () => {
  assert.equal(parseOtp('123 456'), '123456');
  assert.equal(parseOtp('12345'), '');
  assert.equal(parseOtp('abcdef'), '');
  assert.equal(parseOtp(undefined), '');
});

test('defaults: no self-signed certificate, no reduction of the surveillance', () => {
  const config = normalizeConfig();
  assert.equal(config.allowSelfSigned, false);
  assert.equal(config.allowControl, false);
  assert.equal(config.eventSeconds, Number(DEFAULTS.event_interval));
  assert.equal(config.imageSeconds, Number(DEFAULTS.image_refresh));
  assert.equal(config.urlError, 'empty');
  const set = normalizeConfig({
    url: 'nas',
    username: ' gladys ',
    password: ' pw ',
    otp_code: '12',
    allow_self_signed: true,
    allow_camera_control: 'true',
    event_interval: '30',
    image_refresh: '7',
  });
  assert.equal(set.username, 'gladys');
  assert.equal(set.password, ' pw ', 'a password is kept as typed');
  assert.equal(set.otpInvalid, true);
  assert.equal(set.allowSelfSigned, true);
  assert.equal(set.allowControl, true);
  assert.equal(set.eventSeconds, 30);
  assert.equal(set.imageSeconds, 60, 'an unknown value falls back to the default');
});
