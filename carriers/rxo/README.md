# RXO

RXO took XPO's last-mile business when it was spun off in 2022. It delivers big and bulky items
such as appliances and furniture to homes for retailers in the United States and Canada, collects
returns and sends technicians to install them. It is not [XPO](../xpo-ltl/README.md), which kept
XPO's freight business. The adapter covers RXO's last-mile consumer tracking at track.rxo.com.

## How it works

1. `direct`: reads `clm.rxo.com/trackapi/orders/trackbillto/<number>?billTo=0`, the lookup the
   tracking page's script makes for a number, across every retailer. The reply lists the order's
   appointments: deliveries, return pickups and installation visits, each with its status code and
   events.
2. `retry`: a read that fails to reach the lookup, or hangs, is made once more. The first try gets
   half of the budget.

- No session, key or CAPTCHA. The lookup reads `Accept-Language` as a culture and refuses `*`, so
  the adapter sends `en-US`.
- The reply must name the number asked as an appointment's tracking number or sales order id;
  another order's reply leaves the answer open.
- A number the lookup holds no order under gets an empty list with HTTP 200, read as not found. The
  page then says "Sorry, we can’t seem to find any matches with that information." A block page is
  a challenge, a redirect or a 404 a moved tracker, and a reply of another shape a changed one.

## Notes

- An order can hold several appointments, such as a delivery the customer rescheduled en route
  and the one that delivered it. Their events are read together, newest first; the newest
  appointment gives the retailer and the window.
- A stop that was not performed still closes with "Delivery completed" or "Return completed". The
  page shows it as an exception when the stop carries "Cannot Perform Stop", or every item "Cannot
  Pickup/Deliver Item", and the adapter reads that closing event as the exception's failed attempt,
  keeping the original wording.
- Installation visits move no parcel: their events keep the stage of the delivery before them, and
  their own "Order Created" is dropped.
- Event times are the hub's wall clock without a zone, kept in `local_time`. Appointment windows
  state their offset, or come as a wall clock for some retailers; an open appointment's window is
  the estimate.
- Coordinates, addresses, items and the retailer's references are never read.

## Limitations

- No detection rule: RXO publishes no number format, and its tracker also takes retailers' order
  ids. Select RXO, or open an RXO link.
- The status codes beyond those in [`statuses.json`](statuses.json) come from the page's script,
  not from replies.
- The lookup answers a known order slowly, far more slowly than an unknown number, so the adapter
  wants a long budget.

## Numbers

RXO's tracking numbers seen are RXO and fifteen letters and digits; the sales order id of an
order also opens it. The adapter takes 8 to 30 letters and digits with at least one digit, in
capitals. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens a number from its `trackingnumber` parameter. XPO's former tracker took the
same parameter.

## Testing

`npm run test:carriers:live -- carriers/rxo`

The live test tracks the first sample in `numbers.json` and checks the not-found answer;
`RXO_TRACKING_NUMBER` tracks another number, and `RXO_UNKNOWN_NUMBER` another unknown one.
