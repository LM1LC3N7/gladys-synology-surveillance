# TODO — Synology Surveillance Station v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #226).

## Status

- [x] **Milestone 1 — core** (2026-10-17): DSM Web API client (API
      discovery, login by POST with session `SurveillanceStation`, 2-step
      verification code once then device token in `/data`, session renewed
      once, refused login final and remembered across restarts), TLS strict
      by default or trust-on-first-use pin when allowed; one Gladys camera
      per Surveillance Station camera (snapshot live and pushed, enabled
      switch, motion sensor, badge), station device with Home Mode; motion
      by polling `Event.List` (triggers `motion_detected`), trigger
      `home_mode_changed`; commands serialized, state re-read before acting,
      3.5 s budget, reductions of the surveillance off by default; buttons
      "Test the connection" and "Trust the new certificate"; docs en/fr.
      Tested with unit tests against the SDK's fake Gladys, a fake NAS
      (in memory and on loopback) and loopback http / https servers.
      **Never tested against a real NAS.** No Docker on this PC: no e2e test
      in a container.
- [ ] **Milestone 2 — real NAS** (a tester with Surveillance Station):
      record real answers as fixtures (secrets removed), fix what differs.
      To check first:
  - `Camera.List` v9: the name field (`name` / `newName`), `enabled`,
    `status` values (the unreachable list in `src/constants.js` comes from
    the API guide);
  - `Event.List` v5 vs `Recording.List` v6 on SS 9.x: field names
    (`eventId`, `cameraId`, `startTime`, `stopTime`, `recording`), the sort
    order, whether `fromTime` is honoured, the reason codes (2 motion, 7
    analytics?) and how long a motion event stays "recording";
  - the NAS clock vs the container clock (the 15-minute window absorbs a
    skew, the motion hold uses the container clock only);
  - `GetSnapshot`: the size of real snapshots per profile, the time it
    takes (onGetImage has 15 s), the answer for a disabled or disconnected
    camera (error 402? an empty image?);
  - `Camera.Enable/Disable` with `idList` on v9, and the privilege needed
    (error 105 with a spectator profile?);
  - `HomeMode.Switch` `on=true|false`, and whether DSM answers before or
    after the change is effective;
  - the login with 2-step verification: `did` vs `device_id` in the answer
    (DSM 7.2), the device token accepted on the next logins, and what DSM
    answers once the device is revoked;
  - the default DSM certificate (signed by a per-NAS "Synology Inc. CA"):
    pinned leaf fingerprint, renewal behaviour;
  - error 119 / 106 after a DSM restart, auto-block after failed logins.
- [ ] **Milestone 3 — more**: motion detection on/off per camera
      (`Camera.Event` `MDParamSave`), manual recording start/stop, PTZ
      presets, the live stream path (`GetLiveViewPath`, RTSP) for go2rtc,
      the Action Rule webhook of Surveillance Station as a push alternative
      to polling, several NAS.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published (at milestone 1
      its only error is the `docker_image` not yet pullable from GHCR).

## Decisions

- **Not a duplicate** (checked 2026-10-17): the store index
  (integration-store-storage.gladysassistant.com/index.json) has no
  Surveillance Station integration; `prohand/gladys-synology` ("Synology
  DSM") covers system metrics, volumes, disks and backups only.
- **Reuse**: py-synologydsm-api (mib1185, MIT, commit `5c486c4`, the library
  of Home Assistant's Synology DSM integration) is the reference: its
  request flow (SYNO.API.Info discovery, version clamped to the NAS range,
  login by POST with `enable_device_token`, session error 119 renewed once),
  its Surveillance Station calls (`Camera.List`, `GetSnapshot` with
  `profileType`, `Enable`/`Disable` with `idList`, `HomeMode.GetInfo`/
  `Switch`) and its error tables are ported to JavaScript. MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency
  besides the SDK (a Python library cannot be used from Node).
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first patch release gives 0.1.1.
- **External ids**: `camera:<Surveillance Station camera id>` (the id SS
  gives a camera, stable while it exists) and `station:main` (one NAS per
  integration). Features `image`, `enabled`, `motion`, `home_mode`.
- **Feature types**: the enabled state is a `switch`/`binary`, not the core's
  `camera`/`enabled` gate: that one is a Gladys-side privacy gate whose
  support depends on the core version, and mixing it with an SS command
  gated by `allow_camera_control` would be confusing. Motion is
  `motion-sensor`/`binary`, Home Mode `switch`/`binary`.
- **Safety of the commands**: disabling a camera and turning Home Mode on
  reduce the surveillance, like disarming an alarm: refused unless
  `allow_camera_control` (off by default). Enabling a camera and leaving
  Home Mode are like arming: always allowed. Every command goes through one
  queue, re-reads the state on the NAS just before acting (unknown state:
  refused; same state: nothing sent), and is refused before sending once
  3.5 s have passed since it arrived (Gladys waits 5 s); the deadline is
  passed down to every HTTP request, the login included. A command whose
  request fails without an answer is reported "no confirmation" and the
  state is read again 2 s later.
- **Login refusals**: DSM auto-blocks an address after a few failed logins,
  so a refused login (400 to 411 of SYNO.API.Auth, OTP codes included) is
  never retried by the integration itself: not by the loops, not by a
  reconnection to Gladys, not by a restart (a SHA-256 of origin, user,
  password and code is kept in `/data` with the DSM code). Saving the
  configuration or pressing "Test the connection" tries once. A transient
  failure (network, timeout, HTTP error, TLS) retries after 30 s, doubling
  up to 10 min.
- **2-step verification**: the code is a configuration field (Gladys has no
  interactive prompt); sent once (the last code sent is remembered in
  `/data` and never resent), with `enable_device_token=yes`; the `did`
  returned is kept in `/data` (mode 0600) and sent as `device_id` next time.
  The docs recommend a dedicated account without 2-step verification.
- **TLS**: strict by default (`rejectUnauthorized`). With
  `allow_self_signed`, trust on first use like gladys-frigate: the handshake
  is made first, a certificate that validates for the host needs no pin,
  otherwise the SHA-256 fingerprint is pinned the first time and a
  different one refused BEFORE the request (and the password) is written.
  "Trust the new certificate" clears the pin.
- **Secrets**: the password is a `secret` field (kept in clear in the Gladys
  database, masked in the UI: never "encrypted"); it is sent only in the
  POST body of the login; the SID goes in the query string of the other
  requests (as DSM documents it), so it may appear in the NAS's own access
  log, never in ours. Logs carry codes, never the password, SID, device
  token or OTP (tested).
- **Motion by polling**: Surveillance Station has no push API besides Action
  Rules (webhooks configured by hand): `Event.List` is read every 5-60 s
  (10 s default), one request for all cameras, the last 15 minutes, 50
  events. Each event key (`camera:id:start`) fires once (500 remembered);
  the first reading only arms. The motion sensor is 1 while a motion event
  is still recording, or for 30 s after a new one was seen (container
  clock). States go through `publishChangedStates` (only changes: far under
  300 states/min).
- **Images**: `GetSnapshot` profile balanced, then low bandwidth, until the
  `image/jpg;base64,` string fits 150 KB (live) or 60 KB (pushed, stored by
  Gladys); no resizing in JavaScript (no runtime dependency). Pushed every
  30 s to 10 min (60 s default), cameras in turn: at most 2 images/min per
  camera, under the 12/min limit.
- `gladys_version >=5.1.0` (scene triggers). Single container, 256 MB is
  plenty (no image decoding).
