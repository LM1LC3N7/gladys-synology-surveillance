# gladys-synology-surveillance

[Gladys Assistant](https://gladysassistant.com) external integration for
**Synology Surveillance Station**, locally through the Web API of DSM: each
camera becomes a Gladys camera (snapshots, enabled state, motion sensor), the
Home Mode becomes a switch, and motion events and Home Mode changes are scene
triggers. **Unofficial integration, not affiliated with Synology. Never tested
on a real NAS yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (SurveillanceApp)
                 ├─ src/synology/client.js   DSM Web API: discovery, login, session, SS calls
                 ├─ src/synology/http.js     the only network access (node:http / https, TOFU pin)
                 ├─ src/synology/errors.js   DSM error codes, retry policy
                 ├─ src/store.js             /data: device token, certificate pin, refusals
                 └─ src/devices.js           cameras and station (pure)
```

- **Login**: `SYNO.API.Info` (paths, versions), then `SYNO.API.Auth` `login`
  by POST, session `SurveillanceStation`, with a 2-step verification code
  once and the device token afterwards. A session error (106, 107, 119)
  renews the session once; at most one login every 30 s. A refused login
  (400, 401, 402, 403, 404, 406, 407…) is final: nothing logs in again until
  the configuration is saved or "Test the connection" is pressed; a salted
  HMAC of the refused values is kept in `/data` so a restart does not retry
  either. HTTP 429 pauses everything (Retry-After, 1 min to 6 h).
- **Status** (every minute): `Camera.List` (v7: enabled, `camStatus`) and
  `HomeMode.GetInfo`; states through `publishChangedStates` (only changes); a
  reading crossed by a command is dropped.
- **Motion** (every 5 s to 1 min): `Event.List` (or `Recording.List`) of the
  last 15 minutes; motion (reason 2) and analytics (7) events, each fired
  once, only within 2 minutes of their end; a mark in `/data` carries over
  restarts.
- **Images**: `Camera.GetSnapshot`, balanced profile, else low bandwidth.
- **Commands**: one queue, bound to the client of their arrival; disabling a
  camera and turning Home Mode on are refused unless `allow_camera_control`
  (checked again just before sending); the state is read just before
  acting; nothing is sent past 3.5 s after the command arrived.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake NAS
(`test/helpers/fakeNas.js`, answers shaped after `test/fixtures/`), plus
loopback http / https servers for the transport. No test touches a real NAS
or the Internet.

## Credits

- [py-synologydsm-api](https://github.com/mib1185/py-synologydsm-api) by
  mib1185 (MIT): the request flow, the Surveillance Station calls and the
  error tables are ported from it (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-go2rtc](https://github.com/LM1LC3N7/gladys-go2rtc) and
  [gladys-frigate](https://github.com/LM1LC3N7/gladys-frigate): the structure
  of the app, the camera images and the certificate pinning.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
