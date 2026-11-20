# Matson

Matson, based in Honolulu, carries containers, vehicles and freight by sea between the US mainland,
Hawaii, Alaska, Guam and the Pacific islands, and from China. Its site is matson.com. Tracked
through the lookup its shipment tracking page posts to.

## How it works

1. `direct`: `GET https://www.matson.com/shipment-tracking.html` for the token its form carries
   (`<input id="ttr">`), then a form `POST` to
   `/wp-content/plugins/matson-plugin/Api_calls/tracking_booking_proxy.php` with
   `container_trackingnumber`, `trackingVal` and `ttr`, as the page's script sends it:
   `tckconta` for a container, `tckbok` for a booking, `tckbil` for a bill of lading. It answers
   JSON: a container's record for a container, a list of the booking's containers for a booking
   or bill, an empty list for a number it does not hold.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of it.

No key, account or CAPTCHA is needed. The lookup refuses with HTTP 403 a post without the page's
token or without the script's `X-Requested-With`, `Origin` and `Referer` headers, and the site's
edge refuses a bare command-line client. The adapter reads a 403 as a challenge.

## Notes

- A container lookup finds the container by its first ten characters whatever the check digit,
  so the adapter checks the ISO 6346 digit and requires the reply's container and digit to be the
  number asked. A booking or bill reply must name its booking on every container.
- A date is the epoch of the place's wall clock written on Pacific time: the page shows it on
  `America/Los_Angeles`, and says events are recorded in local time. The adapter keeps that
  rendering as a wall clock, without an instant.
- An event's name is padded to a column before what follows it: the vessel and voyage, the
  trucker, or a hold's reason. The name is the provider code. A container lookup gives the names
  alone and leaves out the shipper and consignee.
- Wording is mapped in [statuses.json](statuses.json). `AVAILABLE` is the container waiting at
  Matson's yard for the consignee's trucker, and `RETURNED FROM CONSIGNEE`, the empty container
  back, is the delivery. A hold for customs or the radiation screening is customs; a hold Matson
  gives no reason for keeps the stage before it.
- A booking's containers are merged and moves they share kept once. A delivery decides the stage
  only once every container has one.
- The vessel's arrival estimate, the ports, the equipment, its weight and the commodities are not
  read. The estimate is the vessel's at the port, not the cargo's delivery.

## Limitations

- The tracker keeps a container about 90 days after its last move. A booking or bill keeps its
  history longer.
- Vehicles are tracked on `/auto-tracking.html`, which posts to `Api_calls/webtrack_proxy.php`.
  The adapter does not read it.
- Too many lookups get HTTP 429 and a five-minute block.

## Numbers

Matson tracks containers by their ISO 6346 numbers, bookings by seven digits, and bills of lading
as `MATS`, the booking number and three more digits. The adapter takes those three shapes.
Detection has no rule: the shapes are shared with other lines. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

No tracking link is known.

## Testing

`npm run test:carriers:live -- carriers/matson`, with `MATSON_TRACKING_NUMBER` and
`MATSON_UNKNOWN_NUMBER` set outside the repository.
