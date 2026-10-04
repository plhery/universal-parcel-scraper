# Fixtures

- `delivered.json`: a delivered `detail.json` module (four scans up to `GTMS_SIGNED`, an ETA window, a partner handoff number, and a recipient block the adapter must ignore).
- `in-transit.json`: the same module mid-journey, line-haul scans only, with an open ETA window.
- `delivered-dofr.json`: a synthetic Cainiao-issued module for automatic detection and direct retrieval.

All are constructed from the response shape; every identifier, name, address and time is synthetic. Scans keep their `timeZone`; the first two include the Beijing-based epoch `time`.
