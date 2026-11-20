# KMTC

Korea Marine Transport Co. is the South Korean container line. Tracked through the service behind
the cargo tracking page of its website, for a bill of lading or a booking.

## How it works

1. `direct` asks `https://api.ekmtc.com/trans/trans` as the page does:
   - `pow/challenge` for a proof of work: a signed salt and a SHA-256 hash. The adapter finds the
     number up to the given maximum whose hash after the salt is that hash, and sends the answer
     as the `pow-token` header of the search;
   - `cargo-tracking/` with the number and its kind, `BL` or `BK`, which lists the containers;
   - each of the first six containers' moves, `cargo-tracking/{bill}/detail`, under its booking.
2. `retry` asks once more when a request did not reach KMTC.

The service sits behind Akamai, which turns away a client that does not name a browser; a Chrome
user agent is enough. The proof of work is the page's own anonymous check, solved locally in a
fraction of a second. No account, cookie or CAPTCHA is needed.

## Notes

- A search must name the number asked. No containers is a number KMTC does not hold, unless the
  reply marks the search closed, which is maintenance. Containers without moves are no history.
- Like the page, a container's moves before its latest empty pick up are set aside: they belong
  to its previous trip.
- Each move is coded by its kind, leg and load. The return of the empty container is the
  delivery, and the consignee's pick up of the full container goes out for delivery. An empty
  container returned before it moved is an unused one, and a gate in after the container moved
  is transit. Depot moves after the return have no stage. The page's names are staged in
  [statuses.json](statuses.json); other codes are named from their parts.
- A bill's containers move apart. The bill is delivered once every container is back; until then
  the latest open stage leads. Containers past the first six are not asked, and the history is
  marked truncated.
- Times are wall clocks at the move's place, read in its country's zone, or for a US port in its
  state's zone where the adapter knows it. Others keep their wall clock.
- Vessels, voyages, estimated dates and rail legs (`inlandList`) are not read.

## Limitations

- A guest can track bills and bookings, not containers.
- Transshipment moves have no page name and are named from their code.

## Numbers

Bills are three letters for the issuing office and seven digits. US import records put KMTC's
SCAC, `KORP`, before them, which the adapter drops. Bookings are two letters and eight digits.
Detection has no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/kmtc`, with `KMTC_TRACKING_NUMBER` and
`KMTC_UNKNOWN_NUMBER` set outside the repository.
