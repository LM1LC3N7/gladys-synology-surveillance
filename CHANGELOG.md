# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Each camera of Synology Surveillance Station as a Gladys camera, found in
  Discovery: a fresh snapshot in the live view (under 150 KB), an image
  pushed to the dashboard at the pace you choose (every 30 s to 10 min, or
  none), its enabled state, a motion sensor and an online / unreachable
  badge.
- The Home Mode of Surveillance Station as a switch, and the scene triggers
  "Motion detected" (motion detection or video analytics, read every 5 s to
  1 min) and "Home Mode changed".
- Local connection through the Web API of DSM with a dedicated account: 2-step
  verification handled once (device token kept in `/data`), a self-signed
  certificate accepted only when allowed (trusted on first use, then pinned),
  a lost session renewed once, a refused password never tried again alone.
- Safety: disabling a camera and turning Home Mode on are refused unless
  allowed in the configuration; every command runs alone, reads the state
  just before acting and sends nothing past 3.5 s.
- "Test the connection" and "Trust the new certificate" buttons.

[Unreleased]: https://github.com/LM1LC3N7/gladys-synology-surveillance/commits/main
