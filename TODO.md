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
- [x] **Review corrections** (2026-10-17): commands bound to their client
      and re-checked just before sending, status readings crossed by a
      command dropped, unknown `enabled` kept unknown, motion mark in
      `/data` and 2-minute age, one timer chain per loop (epoch), Camera.List
      at v7, one login per 30 s, HTTP 429 / 5xx, "not sent" vs "no
      confirmation", 14 s for the live image, 150 KB fallback for the
      dashboard image, snapshot by its bytes, `camStatus`, strict numbers,
      salted HMAC, `camera`/`enabled` feature, OTP as a secret
      (`test/review.test.js` holds the reviewer's reproductions).
- [x] **Approval corrections** (2026-10-17): 2-minute rule only for the
      catch-up readings, NAS clock offset from the `Date` header, all keys
      of the mark's start second, 429 pause kept in `/data` and applied to
      commands / images, readable "not logged in" (`test/approval.test.js`).
- [ ] **Milestone 2 — real NAS** (a tester with Surveillance Station):
      record real answers as fixtures (secrets removed), fix what differs.
      To check first:
  - `Camera.List` (asked at v7, see Decisions): the name field (`name` /
    `newName`), `enabled` always a boolean?, the `camStatus` values (the
    unreachable list in `src/constants.js` comes from the API guide);
    whether a newer version would be needed on SS 9;
  - `Event.List` v5 vs `Recording.List` v6 on SS 9.x: field names
    (`eventId`, `cameraId`, `startTime`, `stopTime`, `recording`), the sort
    order, whether `fromTime` is honoured, the reason codes (2 motion, 7
    analytics?) and how long a motion event stays "recording";
  - the NAS clock vs the container clock (the 15-minute window absorbs a
    skew; the catch-up age of a motion event uses the offset read from the
    `Date` header: does DSM send it, in UTC, through its nginx?);
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
  - error 119 / 106 after a DSM restart, auto-block after failed logins;
    whether DSM ever answers 429 / 5xx with a Retry-After.
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
- **Feature types** (coordinator's decision after the review): the enabled
  state is the core's `camera`/`enabled` feature, like gladys-frigate (same
  author), mapped to Enable / Disable in Surveillance Station. Motion is
  `motion-sensor`/`binary`, Home Mode `switch`/`binary`.
- **Versions per method**: the preferred version of each API, clamped to the
  NAS range, except `Camera.List`, capped at 7 like py-synologydsm-api
  (`max_version=7`), whose parsing was checked on real answers of that
  version; `GetSnapshot`, `Enable`, `Disable` stay at 9.
- **Camera fields**: `enabled` is taken only as a boolean, anything else is
  unknown (no state published, a command refused, an image still tried);
  the camera status is `camStatus`, else `status` (in the answer recorded
  by py-synologydsm-api `camStatus` is 1 while `status` is 0).
- **Safety of the commands**: disabling a camera and turning Home Mode on
  reduce the surveillance, like disarming an alarm: refused unless
  `allow_camera_control` (off by default). Enabling a camera and leaving
  Home Mode are like arming: always allowed. Every command goes through one
  queue, re-reads the state on the NAS just before acting (unknown state:
  refused; same state: nothing sent), and is refused before sending once
  3.5 s have passed since it arrived (Gladys waits 5 s); the deadline is
  passed down to every HTTP request, the login included. The command keeps
  the client of the moment it arrived; just before sending, it is refused
  if the configuration changed (another client or generation) or if
  `allow_camera_control` was unticked meanwhile. A request that failed
  before its connection was up (or a login / deadline refusal) is reported
  "nothing was sent"; one sent without an answer "no confirmation", and the
  state is read again 2 s later. A status reading (loop or Discovery)
  crossed by a command is dropped (state version counter): no stale state,
  no spurious `home_mode_changed`.
- **Timer chains**: `halt()` bumps an epoch; each loop (status, events,
  images) checks it before scheduling its next run, so a run still in flight
  when the NAS failed does not leave a second chain after the reconnection.
- **Login refusals**: DSM auto-blocks an address after a few failed logins,
  so a refused login (400 to 411 of SYNO.API.Auth, OTP codes included) is
  never retried by the integration itself: not by the loops, not by a
  reconnection to Gladys, not by a restart (an HMAC-SHA-256 of origin,
  user, password and code, keyed with a random salt generated once in
  `/data`, is kept there with the DSM code). Saving the configuration or
  pressing "Test the connection" (bounded to 25 s) tries once. A transient
  failure (network, timeout, HTTP error, TLS) retries after 30 s, doubling
  up to 10 min; an HTTP 5xx says "server error" and honours a Retry-After
  (up to 6 h). HTTP 429 pauses every path (loops, commands, images,
  Discovery, even the logout) for its Retry-After, bounded 1 min to 6 h;
  the end of the pause is kept in `/data` (`meta`), so a restart or a
  reconnection to Gladys waits too; only the user lifts it (saved
  configuration, "Test the connection"). A 429 answered to a command or an
  image is reported "refused, not done" and pauses everything.
- **Login rate**: at most one login every 30 s per client, whatever asks
  (a lost session included): a NAS that keeps dropping the session never
  gets a login per request. "Test the connection" and a saved
  configuration start a new client.
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
  events. Each event key (`camera:id:start`) fires once (500 remembered).
  In steady running (armed, previous reading done), every new event fires,
  whatever its age: no clock comparison at all (a NAS late by minutes lost
  every motion before the approval fix). Only the catch-up reading (the
  first after a start, a reconnection to Gladys or a NAS outage) fires just
  the events that ended (or still run) less than 2 minutes ago, in NAS
  time: our clock plus the offset measured with the HTTP `Date` header of
  every NAS answer (also used for `fromTime`); docs ask for NTP on both. A
  mark in `/data` (NAS start time and ALL the keys sharing it) carries over
  restarts: after one, only events newer than the mark (start later, or
  same start and another key) fire; no mark (first start): the events of
  the last 2 minutes fire. An event
  without a stop time is not "still recording" (only `stopTime: 0` or
  `recording: true` are). The motion sensor is 1 while a motion event is
  still recording, or for 30 s after a new one fired (container clock).
  States go through `publishChangedStates` (only changes: far under 300
  states/min).
- **Images**: `GetSnapshot` profile balanced, then low bandwidth, until the
  `image/jpg;base64,` string fits 150 KB (live, every request within 14 s)
  or 60 KB (pushed, stored by Gladys; a camera that never fits goes up to
  150 KB, with one warning); a snapshot is recognized by its bytes (FF D8),
  whatever its content type; no resizing in JavaScript (no runtime
  dependency). Pushed every 30 s to 10 min (60 s default), cameras in
  turn: at most 2 images/min per camera, under the 12/min limit.
- **2-step verification code field**: a `secret` (masked like the
  password). The NAS address says that http sends the password in clear.
- `gladys_version >=5.1.0` (scene triggers). Single container, 256 MB is
  plenty (no image decoding).
