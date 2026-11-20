# Phantom Couriers

Phantom Couriers is a same-day courier in Vancouver and the Fraser Valley that also books
international shipping. Its orders are dispatched on Courie, whose guest portal is Phantom's
tracking page. Tracked through the query that page makes.

## How it works

1. `direct`: one `POST https://api.courie.ai/graphql` with the portal's
   `shipmentByTrackingNumber` query, Phantom's courier id and the order number. It needs no
   cookie, token, key or browser. The reply gives the order's status, when it was created and
   given to a driver, and its stops, each a pick-up, drop-off or return with its city and when
   the driver completed it.
2. `retry`: one more request when the first fails to reach Courie or hangs. The first gets half
   of the budget, so the retry fits in the rest.

- The order in the reply must have the whole number asked.
- An order the courier does not hold is HTTP 200 with an empty answer, which the portal shows as
  "Invalid Tracking Number" and the adapter reads as not found.
- A 403 or a Cloudflare check is a challenge, a 429 a rate limit, and a redirect or a 404 a moved
  endpoint. Courie's firewall refuses curl's default User-Agent; the host's is accepted.

## Notes

- The record dates milestones but words none of them, so the adapter labels each by its field or
  stop: the order created, assigned to a driver, picked up, delivered or attempted, returned. Each
  keeps its field or stop type as the provider code, and an instant in UTC.
- The order's status leads, worded as the portal's status line words it: pending until the pick-up,
  then in transit, then delivered, or attempted when the drop-off was completed as an attempt. A
  failed or deleted order is no longer active, and a hold outranks the rest until the order is
  closed. A status the portal does not name, such as a paused order, leaves the newest milestone's.
- Stops follow their route, the order of their first task. A task's arrival time is left out: the
  record can date the arrival at a drop-off before the pick-up it follows.
- A stop's city and province become its `location`. The portal's full query also returns the
  addresses, contacts, the driver, signatures, photos and the price; the adapter does not ask for
  them.

## Limitations

- No estimate: the portal shows the drop-off's estimated arrival only while the driver is on the
  way, and no public order showed one.
- A number reaches the adapter when it is filed under Phantom or opened from its link: no rule
  claims its numbers, so preflight does not ask it.

## Numbers

Phantom's orders are six-digit counters, a shape many carriers print, so detection has no rule
for them. The portal sends any number of five characters or more; the adapter sends five to
twenty letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`portal.courie.ai/phantom/trackshipment?trackingNumber=` followed by the number opens one order.

## Testing

`npm run test:carriers:live -- carriers/phantom-couriers`, with `PHANTOM_COURIERS_TRACKING_NUMBER`
and optionally `PHANTOM_COURIERS_UNKNOWN_NUMBER` set outside the repository.
