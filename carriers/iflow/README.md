# iFLOW

iFLOW is an Argentine logistics operator that runs warehouses and supply chains for its clients and
delivers their online orders. The adapter reads the API behind its
[web tracker](https://tracking.iflow21.com/).

## How it works

1. `direct`: `GET https://api-btp.iflow21.com/tracking/order/search/{code}`, which answers the
   tracker's internal id as `{"tracking_id":"…"}`, then `GET /tracking/order/{tracking_id}`, the
   order, as the tracker's own script asks them. They need no cookie, token, origin or browser, and
   share the attempt's time.
2. `retry`: the lookup once more when it fails to reach the API or hangs. The first try gets half of
   the budget, so the retry fits in the rest.

- The order lists its shipments, each with its steps and their states. The parcel is the shipment
  whose `shipment_id` is the code asked. The seller's order number (`order_id`) finds an order too:
  it is read only when the order holds one shipment, whose number becomes `canonical_tracking_number`.
  Any other order is an indeterminate answer.
- A state is shown as `date | details - reason`; the adapter keeps that wording, with the internal
  state (`ifowState`) as `provider_code`. The status map stages the internal states seen; another
  state is read by its wording through the shared rules. The recipient's and seller's names, and
  phone and identity numbers, are taken out of the wording.
- `dateSort` is the instant and `date` the Argentine wall clock of it, so a scan's time is the
  instant with Argentina's offset, UTC-03:00 all year. A `date` that is not the instant's wall clock
  is what the tracker shows, and stays a wall clock.
- `estimatedDeliveryDate` gives the window's days without their year. The start is placed on the
  day nearest the newest state's Argentine day, within 90 days, and the end on the first such day
  after it, within 45. A window that cannot be placed so is named in `unread_estimates`.
- The search answers a code it holds no record of, an aged-out one included, with HTTP 500
  `{"statusCode":500,"message":"Internal server error"}`. That cannot be told from a failed lookup, so
  it is indeterminate with the reason `portal_not_found`, which recognition reads as unknown. Another
  HTTP 500 is a transport failure. A search reply without an id is what the tracker words as
  "No pudimos encontrar tu número de seguimiento", and is not found. A failed order read after a found
  search says nothing about the code.
- A return pickup (`delivery_mode` `Inversa`) is a shipment of its own and is read the same way.

## Numbers

The confirmation email gives the code; the tracker's example starts with OR. A published tracker
result shows TRI and thirteen digits, which rule `iflow-1` suggests iFLOW for.

## Links

`tracking.iflow21.com/#/tracking/code/<number>` looks one number up, and the library reads the
number from that address. The tracker's `/tracking/<id>` pages use the internal id instead.

## Limitations

- No place, weight, service, proof of delivery or delivery partner. The label link and the
  satisfaction survey are not read.
- No public number answers on the tracker now, so the found path rests on a synthetic fixture.

## Testing

`IFLOW_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/iflow`. Without it, only the
all-zero code is looked up.
