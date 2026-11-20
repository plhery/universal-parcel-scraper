# Altex Curier

The adapter reads the carrier's anonymous AWB result at `curier.altex.ro`.
It binds the returned heading to the whole AWB and parses the native JSON event
assignment without executing its script. Only the exact AWB-bound missing-result
object is not found; empty, conflicting and verification replies stay distinct.

Scans contain calendar days without clock times. The adapter keeps that precision
and does not infer a delivery instant. An undelivered scan is an exception; it
does not establish that a delivery was attempted. Unknown wordings remain unmapped.

The existing carrier selection supports these lookups. Shared numeric formats do
not establish Altex ownership, so there is no automatic number rule.

Run a live check with a reference supplied outside Git:

```sh
ALTEX_CURIER_NUMBER=... npx vitest run carriers/altex-curier/adapter.live.test.ts
```
