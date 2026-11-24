# Pargo

Pargo is a pickup-point network in South Africa. Shops send orders from their warehouses to its
points or to the door, people send parcels between points, and returns go back to the shops;
couriers carry the parcels. Its [public tracker](https://track.pargo.co.za/) follows an order
under its Pargo code, `PAR` and ten digits, or under the shop's waybill the order was filed with.

## How it works

1. `direct`: one `GET https://track.pargo.co.za/events/orders/{code}`, the lookup the tracker's page
   makes, with the JSON content type the page sends. It needs no session, token or cookie.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the budget.
   The first try gets half of it.

- The reply's tracking code must be the whole code asked; the tracker takes it in any case.
- A code it holds no order for gets HTTP 422 with a `validation_error` naming that code, which is
  not found. An error naming another reference is inconclusive, and any other error is a reply
  the adapter cannot read.
- A block page or a refusal is a challenge, a redirect or a missing route is a transport failure,
  and a page instead of the JSON reply is a changed reply.

## Notes

- Scan times are UTC instants with their offset, so they are kept as such.
- Each scan carries Pargo's event code, whose middle part names the flow: warehouse or point to
  point, to the door, back to the sender, or a customer's return. One wording can mean different
  stages in different flows, so the code decides the stage. The codes come from the webhook
  events in Pargo's API documentation, and the wordings from live replies and its examples.
- On the way to a point, "out for delivery" and the courier's proof of delivery are transit; the
  parcel is ready once it arrives at the point and delivered once collected. A parcel not collected
  goes back to the sender. A customer's return is staged returned once on its way.
- For an order sent from a warehouse to a point, the point's name and address are the pickup point
  once the parcel waits there or was collected, and its name and town become the place of those
  scans. Other flows leave the point out.
- For an order from a shop's warehouse, the shop is the sender.
- The recipient's address, the shop's support contacts and order reference, the courier, the
  point's opening hours and photo, and the progress steps stay behind.
- Detection suggests Pargo for `PAR` and ten digits. Shop waybills have no shape of their own.

## Limitations

- Older orders answer as an unknown code does, so not found does not mean the order never
  existed.
- The scans carry no place; the courier and its waybill are not read.
- No delivery estimate.

## Links

The standalone tracker reads `code` from its query. Older marketing and PHP tracking routes remain
ingestion leads; the current marketing iframe does not inherit their query parameters.

## Testing

`npm run test:carriers:live -- carriers/pargo`

The live test tracks the public sample in `numbers.json` and a made-up code of Pargo's shape;
`PARGO_TRACKING_NUMBER` tracks another code, and `PARGO_UNKNOWN_NUMBER` checks another unknown one.
