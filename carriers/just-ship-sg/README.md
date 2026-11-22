# JustShip

JustShip collects parcels from homes and businesses in Singapore, packs them and sends them abroad
with express couriers or the post. Its tracking page takes the shipping ID JustShip gives each
booking and shows JustShip's own history beside the courier's number.

## How it works

1. `direct`: asks `www.justship.sg/api/shipment/tracking?trackingNumber=`, the service its tracking
   page calls. `{"shipment": null}` is not found.
2. `retry`: a read that fails to reach the service, or hangs, is sent once more.

- The page removes the hyphen it prints after the booking date, and underscores, before it asks;
  the adapter does the same and asks in capitals, which the service needs.
- The reply must carry the shipping ID asked for.
- History times are instants in UTC; the page prints them in Singapore time.
- A scan's place is the state and country the page prints, never more.
- The courier JustShip handed the parcel to and its number become the delivery partner and
  delivery number, so the courier's own tracker can take over.
- The status codes and their labels come from the tracking page's script. A cancelled booking, a
  delay and a disposed parcel read as exceptions; a delay sits with the issues there.
- A Cloudflare or Vercel check page is a challenge, never a missing shipment.

## Limitations

- No delivery estimate or proof of delivery. The recipient's town, the parcels' sizes and weights
  and the pickup slot stay behind.

## Numbers

Shipping IDs open with the booking date as six digits. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/just-ship-sg`

The live test tracks the public sample in `numbers.json`; `JUST_SHIP_SG_TRACKING_NUMBER` tracks
another shipping ID, and `JUST_SHIP_SG_UNKNOWN_NUMBER` checks the not-found answer.
