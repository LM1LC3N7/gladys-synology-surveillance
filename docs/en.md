# Synology Surveillance Station

Your Synology Surveillance Station cameras in Gladys, locally, through the
Web API of DSM (no cloud, no QuickConnect):

- each camera becomes a Gladys camera: its image on the dashboard, a fresh
  snapshot in the live view;
- its **enabled** state in Surveillance Station (a switch);
- a **motion** sensor per camera, and the **Motion detected** scene trigger
  (motion detection or video analytics events);
- the **Home Mode** of Surveillance Station: read, switched, and the **Home
  Mode changed** scene trigger.

> **Never tested on a real NAS.** This first version was written from the
> Surveillance Station Web API guide and from py-synologydsm-api, and tested
> against a fake NAS only. Please report what works and what does not on the
> Gladys forum.

Unofficial integration, not affiliated with Synology.

## Before you start: a dedicated account

1. In DSM, **Control Panel → User & Group**, create a user `gladys` with a
   strong password. It needs no shared folder and no other application.
2. In **Surveillance Station → Privilege settings** (Privilege profiles),
   give it a profile:
   - read only (spectator) is enough for the images, the motion sensors and
     reading Home Mode;
   - to enable / disable cameras or switch Home Mode from Gladys, the
     profile must allow it (manager, or a custom profile with these rights).
3. **2-step verification**: prefer an account without it (the account is
   used by a machine). If DSM enforces it for every account, see below.

## Configuration

- **NAS address**: `https://192.168.1.10:5001` (or `http://192.168.1.10:5000`;
  over http the password crosses your network in clear). A bare address is
  read as https on port 5001.
- **DSM user name / password**: the dedicated account. The password is kept
  by Gladys in its database, never shown again, sent only to your NAS.
- **2-step verification code**: only for an account with 2-step
  verification. Type a fresh 6-digit code of your authenticator app and save
  at once (a code lasts 30 s). Gladys then keeps the device token DSM gives
  (in its `/data` volume) and never needs a code again. A code is sent only
  once.
- **Accept the self-signed certificate of the NAS**: off by default, the
  certificate must then come from a known authority (Let's Encrypt…). On:
  the certificate seen at the first connection is trusted and remembered; a
  different one later is refused (someone may be impersonating your NAS)
  until you press **Trust the new certificate**.
- **Allow reducing the surveillance**: off by default (see Commands).
- **Motion events read**: every 5 s to 1 min (10 s by default).
- **Dashboard image refresh**: none, or every 30 s to 10 min.

Then open the **Discovery** tab and create the cameras and the Surveillance
Station device (Home Mode) you want.

## Commands

- **Enabling a camera** and **leaving Home Mode** add surveillance: always
  possible.
- **Disabling a camera** and **turning Home Mode on** reduce the surveillance
  (fewer recordings, fewer alerts): Gladys refuses both unless you tick
  **Allow reducing the surveillance**. Keep it off if a scene or another
  user should not be able to blind your cameras.
- Commands run one at a time. Just before acting, Gladys reads the current
  state from the NAS: if it cannot, nothing is sent; if the NAS is already in
  the asked state, nothing is sent either. When the NAS is too slow to answer
  within 3.5 s, nothing is sent and Gladys shows a failure (never an action
  after a failure was shown).

## Motion

Surveillance Station does not push its events to Gladys: Gladys reads the
recent events at the chosen pace. A motion or video analytics event fires
**Motion detected** once (with the camera, its name and `motion` or
`analytics`) and sets the motion sensor of the camera; the sensor goes back
to "no motion" once the event is over. The events present at startup fire
nothing. Motion detection must be enabled on the camera in Surveillance
Station (event detection settings).

## Connection problems

- **Wrong password, locked or expired account**: Gladys does not try again by
  itself, because DSM blocks an address after a few failed logins (auto
  block). Fix the configuration and save it, or press **Test the
  connection**.
- **NAS unreachable**: retried after 30 s, then up to every 10 min; the
  cameras show as unreachable meanwhile.
- **Lost session** (DSM restarted, session expired): renewed once, never in a
  loop.

## Limits

- One NAS per integration. Images are snapshots (no live video stream in
  Gladys); a snapshot larger than Gladys accepts (150 KB, 60 KB for the
  dashboard image) is asked again in the "low bandwidth" profile, else it is
  not shown.
- The motion sensor and the trigger lag by up to the chosen pace.
- Only motion (event reason 2) and video analytics (7) events are motion;
  other recordings (continuous, manual, alarm input) are ignored. These
  reason codes are taken from the API guide and are not checked yet.
- Not tested with Surveillance Station on a Synology VisualStation, CMS
  recording servers or C2 Surveillance.
