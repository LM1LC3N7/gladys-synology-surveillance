# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-17

### Added

- Each camera of Synology Surveillance Station as a Gladys camera, found in
  Discovery: a fresh snapshot in the live view (under 150 KB), an image
  pushed to the dashboard at the pace you choose (every 30 s to 10 min, or
  none), its on/off state in Surveillance Station (the camera on/off control
  of Gladys), a motion sensor and an online / unreachable badge.
- The Home Mode of Surveillance Station as a switch, and the scene triggers
  "Motion detected" (motion detection or video analytics, read every 5 s to
  1 min; every new event fires in normal running, whatever the clocks; after
  a restart or an outage only the events of the last 2 minutes, NAS time,
  never twice nor in a burst) and "Home Mode changed".
- Local connection through the Web API of DSM with a dedicated account: 2-step
  verification handled once (device token kept in `/data`, the code field
  masked), a self-signed certificate accepted only when allowed (trusted on
  first use, then pinned), a lost session renewed once and at most one login
  every 30 s, a refused password never tried again alone, a NAS asking to
  slow down (HTTP 429) paused as long as it asks, restarts included.
- Safety: disabling a camera and turning Home Mode on are refused unless
  allowed in the configuration, checked again just before sending; every
  command runs alone, reads the state just before acting (unknown: refused),
  sends nothing past 3.5 s or after a configuration change, and tells "not
  sent" from "no confirmation".
- "Test the connection" and "Trust the new certificate" buttons.

[Unreleased]: https://github.com/LM1LC3N7/gladys-synology-surveillance/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-synology-surveillance/releases/tag/v0.1.1
