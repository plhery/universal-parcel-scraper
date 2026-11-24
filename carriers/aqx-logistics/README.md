# AQX Logistics

AQX Logistics, a forwarder in Inglewood, California, ships parcels by air from the United States to the
Gulf states, the United Kingdom, Europe, Australia and New Zealand. Its site is aqxlogistics.com.

## How it works

1. `direct`: reads `aqxlogistics.com/api/track?id=<number>`, as the tracking page's script does. The
   reply names the shipment's reference, its current status, the service, the origin and the
   destination, the weight and the shipment's events, oldest first.
2. `retry`: a read that fails to reach the tracker, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The reply must name the reference asked; another shipment's reply leaves the answer open.
- A reference the tracker holds no shipment under gets HTTP 404 and "Shipment not found. Please
  check your tracking number.", read as not found. The reply does not repeat the number; the request
  for it does. Another refusal leaves the answer open; the site's firewall answers a request it
  refuses with a plain "Forbidden", read as a challenge, a redirect or a 404 page a moved tracker,
  and a reply of another shape a changed one.

## Notes

- The shipment's status can be ahead of its events: a delivered sample still lists only its
  registration event. A status whose stage differs from the newest event's then leads, without a
  time, and the events stay as they are.
- Event times are instants in UTC, kept with their offset.
- The stage comes from the whole status wording in [`statuses.json`](statuses.json), else the
  shared wording rules.
- The destination country is read; the destination town, the recipient's masked name and the event
  descriptions, which can name the parcel or the person, are never read.

## Limitations

- No estimate and no proof of delivery.
- The adapter takes only AQX's own references: a reply always names one, so a lookup by another
  carrier's waybill could not be bound to the number asked. No reply seen names the carrier that
  flies or delivers the parcel, so no hand-off is made.

## Numbers

AQX's own reference is HF- and eight hexadecimal characters; the adapter takes it with or without
the hyphen. Only the tracker's examples show the shape, so detection has no rule. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

Tracking links carry the number as `id` on the `track` page at aqxlogistics.com.

## Testing

`npm run test:carriers:live -- carriers/aqx-logistics`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`AQX_TRACKING_NUMBER` tracks another number, and `AQX_UNKNOWN_NUMBER` another unknown one.
