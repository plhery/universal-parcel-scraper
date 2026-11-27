# IQ Fulfillment

IQ Fulfillment runs e-commerce warehouses in Dubai and delivers its merchants' orders in the UAE.
Its tracker follows an order from the warehouse to the recipient by the merchant's order
reference, the number the seller's or IQ Fulfillment's email gives.

## How it works

1. `direct`: one `POST https://iqintegrate.com/v1/tracking/history` with
   `{"tracking_number": <reference>}`, as the tracking page at `track.iqfulfillment.com` sends it.
   It needs no cookie, token or check.
2. `retry`: a read that fails to reach the service, or hangs, is sent once more.

- The service picks the tracker by the request's origin: the adapter sends the tracking page's
  `Origin` and `Referer`, and the `X-Domain` header the page's bundle hard-codes, which the
  service does not read. Another origin gets HTTP 404 with `Invalid domain`.
- An unknown reference is HTTP 404 with `You have entered an invalid tracking number.` Any other
  404, such as `Invalid domain` or the answer for a reference under five characters, is a
  changed tracker, not a missing order.
- The reply must name the whole reference asked. The service finds a reference whatever its
  case, and the page uppercases it.

## Notes

- A reference is the merchant's own, in that merchant's layout, so detection offers no carrier
  for it.
- Some references end in a suffix after a hyphen, and the service finds such an order only with
  its hyphen: the same characters without it are another order or none.
  `carrierTrackingNumber()` keeps that hyphen when IQ Fulfillment is the carrier.
- Each milestone is a fixed title over a fixed sentence. The titles are the events'
  descriptions; the sentences repeat them and are left out, with the colours and the picture.
- `Shipped` is the hand-over to the delivery partner, the parcel's first movement. `Not
  delivered` gives no reason and reads as a failed attempt.
- Milestone times are Unix times, kept as instants: deliveries fall in Dubai's daytime.
- Milestones written in the same second keep the reply's order.

## Limitations

- No location, delivery estimate or proof of delivery, and the delivery partner and its number
  are not named.

## Numbers

The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/iqfulfillment`

The live test tracks two public samples, one with a hyphen; `IQFULFILLMENT_TRACKING_NUMBER`
tracks another reference, and `IQFULFILLMENT_UNKNOWN_NUMBER` checks the not-found answer.
