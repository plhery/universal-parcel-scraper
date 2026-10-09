# Packeta

The Central European locker and pickup-point network (Zásilkovna in Czechia), last mile in
CZ, SK, HU, RO and PL. Tracked through the keyless endpoint behind the public tracking page.

## How it works

1. `direct`: one `POST https://tracking.packeta.com/api/getPacketById/{code}/en`. No cookies,
   headers, account or browser state.
   - The echoed `barcode` must match the request, with or without its `Z` prefix,
     otherwise `SchemaError`. The public API returns the ten barcode digits.
   - Ten digits typed without the `Z` are the same packet: the API, older links and
     brokers show them that way. Detection only selects Packeta for the `Z` form.
   - Unknown codes come back two ways, both `NotFoundError`: HTTP 404 `{"error":"notFound"}`,
     or HTTP 200 carrying the same `notFound` error instead of `item`. Expired codes answer
     the same 404, so unknown and expired look identical.
   - Other API errors remain inconclusive. An HTTP 404 without that error signature, or
     another unsuccessful HTTP response, is `UpstreamHttpError`.

## Notes

- The locale is pinned to English. Event sentences are the only per-event signal, and a
  fixed locale turns them into a stable vocabulary that substring matching can classify.
- Two independent maps: `packetStatusId` sets the parcel's stage, the canned sentences set
  each event's stage. The overall stage never borrows from the sentences.
- The `packetStatusId` names come from the tracking page's own script. Only `3` (delivered)
  and the returns `5` and `21` are confirmed live; the other ids are reconstructed. The script
  names `21` LOST_OR_UNKNOWN, but its live wording is "Return (on the way back)", so it maps to
  `returned`. An unmapped id is treated as schema drift: `unknown`, no guessed stage.
- Times are naive and read as `Europe/Prague`, the zone the backend stamps. The result
  carries `timezone: Europe/Prague` so clients render them correctly. Stamping UTC would
  shift every event by one or two hours.
- `sender` (merchant) and `branchAddress` (Z-BOX or partner shop) are kept as sender name
  and pickup point; neither holds recipient data. Recipient name, address, phone and
  signature are never read; a test asserts it.
- For a parcel a courier brings to the door, `courierId` is `"1"` and `branchAddress` names a
  home-delivery branch, such as "PL Home Delivery HD", which Packeta's page does not link to.
  Such a parcel has no pickup point at any stage. Neither has a returned one: its branch is
  then a depot or the point it no longer waits at. A delivered parcel keeps the pickup point
  only when its last movement before the delivery made it ready for pickup there.
- At most 20 events are returned, newest first.
- Links use the canonical `/en/{code}` path; the legacy `?id=` form 301-redirects to it and
  is still recognized.

## Limitations

- No delivery estimate and no event locations.
- Romanian (EET) depot scans can be one hour off: the backend stamps Prague time and events
  carry no locality to correct it.

## Testing

`npm run test:carriers:live -- carriers/packeta`. The wrong-number check
needs no env vars; set `PACKETA_DELIVERED_TRACKING_NUMBER` to also check a real delivered
parcel.
