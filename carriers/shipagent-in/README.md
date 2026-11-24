# ShipAgent

ShipAgent is a Gurugram shipping aggregator: merchants book couriers within India through it, and
its international service sends parcels abroad. Its tracking page takes ShipAgent's own reference
or the AWB of the courier it booked.

## How it works

1. `direct`: asks `api.shipagent.in/api/v1/public/tracking/{number}?source=shipagent.in`, the
   public API that the page at `www.shipagent.in/track/{number}` asks. It needs no session or
   check. Its JSON `NOT_FOUND` error with HTTP 404 is not found; any other 404 is a moved API.
2. `retry`: a read that fails to reach the API, or hangs, is sent once more.

- The reply must name the number asked as its AWB or its own reference.
- The API matches the number case-sensitively, so the adapter sends it in capitals.

## Notes

- The international service runs on ShipGlobal India: its rows are ShipGlobal's, under a ShipGlobal
  AWB that the reply names. The result names `shipglobal-in` and that AWB as the delivery partner.
- For a courier within India the service relays only the courier's current status, as one row
  stamped with the time of the read. That row is no scan, so it is dropped and the answer is a
  summary. The courier the reply names, when the catalog knows it, is the delivery partner under
  the same AWB, which carries the full history.
- Times end in `Z` but are the wall clock of the place each row names, India's at pickup and the
  destination's at delivery, so they are kept without an offset.
- Rows the service codes `unknown` take their stage from their wording; the shipment's status then
  comes from the newest row.
- The order's reference, the towns it goes from and to, its weight and its payment mode stay behind.
- Detection offers no rule: ShipAgent's references follow no published format, and the AWBs belong
  to their couriers.

## Limitations

- No delivery estimate, proof of delivery or recipient.
- A domestic shipment's history comes only from its courier.
- The API allows about 30 lookups a minute from one address; a 429 is a rate limit.

## Testing

`npm run test:carriers:live -- carriers/shipagent-in`

The live test tracks the first public sample in `numbers.json`; `SHIPAGENT_IN_TRACKING_NUMBER`
tracks another number, and `SHIPAGENT_IN_UNKNOWN_NUMBER` checks the not-found answer.
