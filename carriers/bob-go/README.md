# Bob Go

Bob Go is a South African shipping platform: online shops book their parcels with a choice of
local couriers through it, and their buyers follow them on Bob Go's tracker under Bob Go's own
reference. Tracked through the service behind that tracker.

## How it works

1. `direct`: `GET https://api.bobgo.co.za/tracking?tracking_reference={reference}`, the request
   track.bobgo.co.za makes. No account, key, session or browser is needed.
2. `retry`: when Bob Go cannot be reached or hangs, the service is asked again once. The first
   try gets half of the budget.

- The answer lists shipments, each with its state, merchant, courier, service and checkpoints.
  Only the shipment filed under the whole reference asked is read.
- A reference Bob Go does not hold gets HTTP 500 with a message naming it, read as not found.
  Any other 500 stays an upstream error. A 403 or a bot check is a challenge; a redirect is a
  changed service; a 404 or a 410 means it moved.
- Recognition makes the same request.

## Notes

- Bob Go files every courier report under one of its own states, which the map reads as the
  event's code. The event keeps the state's label and the courier's message, as the tracker
  shows them. The shipment's own state sets the current stage when the map knows it.
- Checkpoint clocks carry their offset.
- The checkpoint's location is the courier's hub code, such as a two-letter courier prefix
  before a city code, and is not read: it would read as a place in another country.
- The merchant is the sender and the service level the service. The courier is not kept as a
  delivery partner: the reply gives no number of the courier's own.
- A pickup or delivery PIN, which the tracker shows for some parcels, is never read.

## Limitations

- The delivery estimate is not read: its layout is not known. When a reply fills it, the result
  names the field in `unread_estimates`.

## Numbers

The one public reference is `UA` and six capitals or digits. No rule claims it, so recognition
never asks Bob Go and a lookup reaches it when the carrier is chosen. The adapter takes six to
thirty capitals or digits.

## Links

`track.bobgo.co.za/{reference}` opens the tracker on one reference. A reference Bob Go does not
hold sends it back to its empty home page, so the daily link check cannot verify the link.

## Testing

`npm run test:carriers:live -- carriers/bob-go`, with `BOB_GO_TRACKING_NUMBER` and optionally
`BOB_GO_UNKNOWN_NUMBER` set outside the repository.
