# Econt

Tracks Econt Express shipments in Bulgaria through the trace service behind the tracker on
econt.com.

## How it works

The page at `www.econt.com/services/track-shipment/{number}` shows its tracker in a frame from
`www.econt.com/trace/`. That frame opens a guest session through an OAuth implicit grant
(`client_id=prod_trace_page`) on `www.econt.com/ms-oauth/oauth/authorize`, which answers with a
redirect whose fragment holds a bearer token, without a login. It then posts
`{"waybillNumber": [...], "source": "external"}` with the token to
`www.econt.com/ms-trace/api/trace/waybill`. The adapter makes the same two requests, keeps the
token for the hour it lasts and opens a new session once when the service rejects it. No
account, key, cookie or browser is needed.

The reply must hold exactly one shipment with the whole requested number. Its `isFound: false`
is what the tracker shows as a number it cannot find, so it is not found; Econt also answers
that way once an old shipment's history is purged. Firewall pages, HTTP errors, an `error`
status and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Every shipment number seen on the tracker is thirteen digits, and the trace service reads it as an
integer, so other inputs are invalid without a request. Thirteen digits are shared by several
carriers, so `econt-1` only suggests Econt, and recognition asks it beside the other carriers only
for a parcel looked up from Bulgaria, and for any other once they have all missed the number.

## Notes

Scan clocks are the backend's Sofia wall time: they match the epoch instants Econt's public
API gives for the same scans in summer and in winter. The adapter gives them Sofia's offset,
and keeps a clock in the hour a clock change skips or repeats as local time.

Each scan has a kind, worded as the tracker's English page text words it. Its text names the
office for an office scan, which becomes the location, the line for a line-haul scan and who
took the parcel for a delivery, both added to the wording. The newest delivery's name is the
signatory, and the reply's recipient name field is read. The courier on a courier scan, the
sender name field and an order's number are dropped; an order changing the delivery terms
keeps its subject. A courier scan before any office or line scan is a
pickup from the sender, and later ones take the parcel out for delivery. Scans the reply flags
as the return receipt's are filed under `receipt` without a stage.

The shipment's Bulgarian summary status sets the current stage when it settles one, and the
newest scan does otherwise. A shipment "В офис" is ready for pickup when the reply names the
office storing it, and that office's scan names the pickup point.

## Limitations

Only delivered, waiting-at-office and label-printed shipments were seen live; the other summary
statuses come from Econt's API documentation and the other scan kinds from the tracker's page
text. The tracker gives no estimate, weight or service. Econt's public API at
`ee.econt.com/services/` (`ShipmentService.getShipmentStatuses`) answers the same numbers
without credentials and with epoch clocks, but its documentation asks for an e-Econt account,
so the adapter reads the tracker's own service.

## Live test

Set `ECONT_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/econt/adapter.live.test.ts`.
Optionally set `ECONT_UNKNOWN_NUMBER` to check a not-found number.
