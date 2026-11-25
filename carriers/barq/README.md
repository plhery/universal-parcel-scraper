# BARQ

BARQ, also called BARQ Fleet, is a Riyadh delivery company that brings online orders within hours
inside Saudi cities such as Riyadh, Jeddah, Dammam, Mecca and Medina, for merchants on platforms
such as Salla and Zid. Its sites are barqapp.com and barqfleet.com.

## How it works

1. `direct`: posts the tracking page's `OrderTracking` GraphQL query to `barqfleet.com/graphql/`,
   with the number as `trackingNo`. The reply names the order's number and status, and its logs,
   newest first.
2. `retry`: a read that fails to reach the service, or hangs, is made once more. The first try gets
   half of the budget.

- No session, token or CAPTCHA.
- The reply must name the number asked; another order's reply leaves the answer open.
- A number the service holds no order under gets, with HTTP 200, "Invalid Tracking Number" for the
  order and "Order not found" for its logs, read as not found. The reply does not repeat the
  number; the request for it does. Any other error, or one half answering without the other,
  leaves the answer open; a block page is a challenge, another HTTP status a moved service, and a
  reply of another shape a changed one.

## Notes

- Each log carries a status code, its wording and a time with its offset, which is kept. Logs
  carry no place.
- Codes are staged by [`statuses.json`](statuses.json), read from the tracking page's script, which
  groups them into its steps. `intransit` is the step the page describes as the courier on his way
  for delivery, so it is out for delivery.
- The order's status leads, with the reason the service gives for it.
- The query leaves out what the page also asks for: the merchant's name and logo, and the pickup's,
  the destination's and the courier's coordinates.

## Limitations

- No estimate and no places.

## Numbers

The help centre describes order numbers as two letters and nine digits, sent to the recipient by
SMS. The service reads the letters only in capitals, so the adapter puts them in capitals. Other
carriers' references share the shape and BARQ publishes no prefix, so detection has no rule. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

Tracking links carry the number as `trackingId` on the English or Arabic tracking details page.

## Testing

`npm run test:carriers:live -- carriers/barq`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`BARQ_TRACKING_NUMBER` tracks another number, and `BARQ_UNKNOWN_NUMBER` another unknown one.
