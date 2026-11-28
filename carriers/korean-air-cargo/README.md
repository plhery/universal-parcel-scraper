# Korean Air Cargo

Korean Air's cargo arm tracks freight on a master air waybill with Korean Air's IATA prefix 180.

## How it works

1. `direct`: the public tracking page opens a guest session on each visit. Drupal writes the session id into
   the page's settings and sets it with a guest token as cookies. The adapter sends those cookies and the id to
   `/cargoportal/services/trackawb` in the request the tracker's script builds for a guest: the prefix and the
   serial, Seoul's clock, and the script's defaults for a visitor who has not signed in. The reply names the
   waybill it answers, which must be the whole requested one.

## Notes

- The page's settings name the visitor's region, but the guest token is issued for Korea and the service
  refuses a session whose region differs. The script's default region, Korea, is sent instead.
- Each station writes its own clock without an offset, so events keep their wall clocks. Each status also
  carries a UTC clock, which the tracker sorts by; the adapter orders the history the same way and falls back
  to the wall clocks when a status lacks one.
- The reply's `eventDesc` is the event's wording and `eventCode` its Cargo-IMP code. The found reply's fields
  come from the tracker's script, and its fixture is synthetic: no published waybill is recent enough for the
  tracker to answer.
- An unknown or expired waybill comes back with the message `EET600`, "No tracking data available." A
  rejected session (`ESC401`) or a refused request is a changed tracker, not a missing waybill.
- A booking on several flights is listed once per flight; the copies are kept once.

## Limitations

- The reply's flight plan, pieces, weight, commodity and temperature log are not kept.
- The tracker opens on an empty form and keeps the waybill in the browser's session storage, so no link names a
  waybill.

## Testing

`KOREAN_AIR_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/korean-air-cargo`
