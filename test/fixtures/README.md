# Test fixtures

Answers of DSM's Web API, written from the Surveillance Station Web API
guide and from the parsing of py-synologydsm-api (mib1185, MIT): field names
and types as documented there. **Not recorded from a real NAS**: once a
tester sends real answers (secrets removed), replace these files and fix the
code where they differ (see TODO.md).

- `api-info.json`: `SYNO.API.Info` `query` (paths and version ranges).
- `camera-list.json`: `SYNO.SurveillanceStation.Camera` `List` (v9): one
  camera disabled (`status` 7).
- `events.json`: `SYNO.SurveillanceStation.Event` `List` (v5): one finished
  motion event (`reason` 2), one continuous recording still running
  (`reason` 1, `stopTime` 0).
- `tls/`: test-only certificates (see `tls/README.md`).
