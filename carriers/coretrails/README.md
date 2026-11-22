# Coretrails

Coretrails ships and tracks e-commerce parcels across the United States under its own numbers,
which start with CRT. A shipping partner collects the parcel and a last-mile network, which the
tracker calls "carrier", delivers it. Its tracker keeps shipments of the last year.

## How it works

1. `direct`: one `GET https://coretrails-production-80157501098.us-east4.run.app/api/tracking?tracking_number={number}`,
   the service the tracking page at `www.coretrails.com/home/{number}` asks. It needs no session,
   token or browser. The reply is JSON: the status code, an estimate when there is one, and the
   scans newest first.
2. `retry`: a read that fails to reach the service, or hangs, is sent once more. The first try
   gets half of the budget.

- An unknown number is HTTP 404 with an empty body. Only that answer is not found: an unknown
  route answers HTTP 500, and a 404 with a body is a moved route.
- The service matches the whole number in capitals, so the adapter sends it in capitals, and the
  reply must echo it.
- A 403 or a browser check in place of the reply is a challenge.

## Notes

- Scans keep their wall clock. The reply labels each time GMT, but that is its date format: a
  collection at a post office open from 9:00 shows 11:28, which would be before opening as GMT.
- The scans are the last-mile network's, worded as on its own tracker with its name replaced by
  "carrier". [`status.ts`](status.ts) stages the recorded wordings, and the shared wording rules
  stage the others.
- A delivery scan names the recipient's address and a pickup notice names the post office's street
  address and hours. The adapter keeps a town, state and ZIP code, or a facility's name, and drops
  any other place.
- The tracker gives no code for a scan; `latest_status` is the shipment's.

## Limitations

- No offsets, proof of delivery or the last-mile network's own number.

## Testing

`npm run test:carriers:live -- carriers/coretrails`

The live test tracks the public sample in `numbers.json`; `CORETRAILS_TRACKING_NUMBER` tracks another
number, and `CORETRAILS_UNKNOWN_NUMBER` replaces the invented number of the not-found check.
