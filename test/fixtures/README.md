# Test fixtures

Answers of DSM's Web API, written from the Surveillance Station Web API
guide and from the parsing of py-synologydsm-api (mib1185, MIT): field names
and types as documented there. **Not recorded from a real NAS**: once a
tester sends real answers (secrets removed), replace these files and fix the
code where they differ (see TODO.md).

- `api-info.json`: `SYNO.API.Info` `query` (paths and version ranges).
- `camera-list.json`: `SYNO.SurveillanceStation.Camera` `List`, shaped after
  the real DSM 6 answer recorded in py-synologydsm-api
  (`tests/api_data/dsm_6/surveillance_station/const_6_surveillance_station_camera.py`):
  same top-level fields (`camStatus` 1 while `status` is 0, `enabled`,
  `recStatus`, `snapshot_path`...), trimmed of the nested `detailInfo`, three
  cameras instead of one, the third disabled (`camStatus` 7, a value of the
  API guide).
- `events.json`: `SYNO.SurveillanceStation.Event` `List` (v5): one finished
  motion event (`reason` 2), one continuous recording still running
  (`reason` 1, `stopTime` 0).
- `tls/`: test-only certificates (see `tls/README.md`).
