# LOT Cargo

LOT Polish Airlines' cargo arm tracks freight on a master air waybill with LOT's IATA prefix 080.

## How it works

1. `direct`: the public tracker's page writes a bearer token into a script on each visit. The adapter reads it,
   then asks `api.lot.com/cargo/parcel/search` for the whole waybill with that token and the key the tracker's
   script gives every visitor. The reply is LOT's XML message list converted to JSON. The adapter checks the
   waybill it names before reading the station messages.

## Notes

- Each station writes its messages on its own clock and the reply gives no offsets, so events keep their wall
  clocks and follow the order LOT received them. A New York arrival can read earlier than the Warsaw departure
  before it.
- Bookings, acceptance and departures are placed at the segment's origin airport; arrivals, notices to the
  consignee and deliveries at its destination.
- After arrival LOT notifies the consignee or its agent and hands over the documents; until a delivery message
  comes the freight waits at the airport for collection.
- An unknown waybill comes back with HTTP 404 and LOT's "Could not find AWB" message. A refused key or token is
  a changed tracker, not a missing waybill.

## Limitations

- The reply's flight plan, pieces, weight and volume are not kept.
- The tracker opens on an empty form, so no link names a waybill.

## Testing

`LOT_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/lot-cargo`
