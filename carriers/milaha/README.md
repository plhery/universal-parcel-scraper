# Milaha

Milaha, formerly Qatar Navigation, is Qatar's container line, with services across the Gulf, the
Indian subcontinent and East Asia. Tracked through the lookups its e-commerce site's tracking
form makes for a booking or a container.

## How it works

1. `direct`: `GET https://erp-qnl.solverminds.net/ecomonline/` opens an anonymous session, then
   the session posts the home page's tracking form to `tracking.do` and asks
   `TrackingDetails.do` for the number, as the page does. The reply lists the booking and its
   containers, each with its latest move; `ecomAjax?type=containermovement` then gives each
   container's moves under its booking. It needs no account.
2. `retry`: one more attempt in a new session when the first fails to reach Milaha or hangs. The
   first gets half of the budget, so the retry fits in the rest.

- The form shows a picture code, which only the page checks: the server takes the form without
  it, so the adapter reads no picture.
- The tracker answers only a session that posted the form; another goes to its expiry page, read
  as an inconclusive answer.
- A number the tracker holds nothing for comes back with its script naming the number as invalid,
  read as not found. It words a booking without moves the same way.
- A 403 or a browser check is a challenge, a 429 a rate limit, and any other redirect a moved route.

## Notes

- A reply must name the booking asked for, as its booking or bill, or list the container asked for.
- Moves are named in capitals and staged in [statuses.json](statuses.json): the empty container
  sent to the shipper is registered, its return full is acceptance, loading, transhipment and
  discharge are transit, the container sent to the consignee is out for delivery, and its empty
  return is the delivery. A name the map does not know keeps no stage.
- A booking's containers move apart. The booking is delivered once every container is back; until
  then the latest open stage leads. Moves the containers share are kept once.
- Times are the port's wall clock, as the page says, without a zone.
- The moves of up to twelve containers are read; the others keep the latest move the booking
  lists, and the history is marked truncated. A container whose panel lists no move keeps that
  latest move too.
- The ports of loading and discharge, the ETA, the container type and the service, vessel and
  voyage of each move are not read.

## Limitations

- A container lookup returns the container's latest booking, which may be a later shipment than
  the one asked about.
- No estimate, weight or proof of delivery.

## Numbers

Bookings are also their bills: `MIL` or `QNL`, the office's country, a digit, sometimes a port,
then the serial. Containers are ISO 6346 numbers, whose check digit is checked before the lookup.
Detection has no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/milaha` tracks the first public sample in `numbers.json`;
`MILAHA_TRACKING_NUMBER` tracks another number and `MILAHA_UNKNOWN_NUMBER` checks the not-found
answer, both set outside the repository.
