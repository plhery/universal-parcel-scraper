# Ocean Network Express

Ocean Network Express (ONE), based in Singapore, is the container line NYK, MOL and K Line formed
from their container businesses. Tracked through the API its cargo tracking page asks.

## How it works

1. `direct`: for a booking, or a bill of lading written as `ONEY` and the booking, a `POST` to
   `https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace/validate-booking` with
   `bookingNos` answers the booking to search in `bkgAfter`, empty for one ONE does not hold. A
   `POST` to `…/search` with the booking (`BKG_NO`) or the container (`CNTR_NO`) answers the
   containers, each with its booking. `GET …/cop-events?booking_no=…&container_no=…` answers a
   container's events. The adapter asks for at most twenty containers' events, four at a time.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of it.

No key, cookie, account or CAPTCHA is needed: the API answers plain HTTP. The site's pages sit
behind Cloudflare, which refuses command-line clients with HTTP 403. The adapter reads a 403 or a
challenge page as a challenge.

## Notes

- An event gives its place's wall clock labelled as UTC, `eventLocalPortDate`, and its instant
  in UTC, `eventDate`. The adapter keeps the instant with the offset their difference gives. A
  move ONE lists without a date cannot be placed and is left out.
- A move marked `ESTIMATED` is one ONE plans. It is kept as a planned step and sets no stage or
  estimate.
- Events are staged by their matrix id in [statuses.json](statuses.json). ONE appends a count to
  a transshipment's id, as in `E067-01`; the stage holds for any count. The empty container's
  return after the consignee unloaded it is a delivery, and ONE can date it before the delivery
  itself. A gate in at the port after the container moved inland is transit.
- A booking's containers are merged and the moves they share kept once. A delivery decides the
  stage only once every container has one. A container beyond the twenty asked about counts by
  the name of its latest event in the search reply, and the history is marked as cut short.
- A container lookup keeps the container's latest booking: its earlier bookings are other
  shipments. The container's check digit is checked before the lookup.
- The page's script lists a booking ONE moved to its earlier tracker in `bkgBefore` and links
  there. The adapter reads such a booking as inconclusive.
- The vessel, the ports, the weight, the customs dates and the free-time deadlines are not read.

## Limitations

- The adapter does not read ONE's earlier tracker.
- A booking with more than a hundred containers is cut to the first hundred the search returns.

## Numbers

ONE tracks containers by their ISO 6346 numbers, bookings by twelve or thirteen letters and
digits, and bills of lading as `ONEY`, its carrier code, and the booking. The adapter takes those
three shapes. Detection has no rule. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The page takes a number in its `trakNoParam` query parameter, but shows nothing for a bill of
lading with its `ONEY` prefix, which a link template cannot remove. There is no tracking link.

## Testing

`npm run test:carriers:live -- carriers/ocean-network-express`, with
`OCEAN_NETWORK_EXPRESS_TRACKING_NUMBER` and `OCEAN_NETWORK_EXPRESS_UNKNOWN_NUMBER` set outside the
repository.
