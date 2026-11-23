# Pasha Hawaii

Pasha Hawaii is the Jones Act container line between the US West Coast and Hawaii. Tracked
through the tracker that pashahawaii.com's track and trace page frames, for a container, a bill
of lading or a booking.

## How it works

1. `direct` posts the tracker's search form to `https://web01.pashahawaii.com/PHLiner/Tracking`,
   `SearchType` (0 booking, 1 bill of lading, 2 container) and `SearchTerm`:
   - a container's search answers with its table of moves;
   - a bill's or booking's search answers with its containers; each of the first three is then
     searched as a container, as the inquiry's links do.
2. `retry` searches once more when a request did not reach the tracker.

No cookie, account, CAPTCHA or browser is needed.

## Notes

- The form echoed in the reply must hold the search type and number asked, and the inquiry's
  title and header must name them. The tracker's "is not on file" answer to that search is a
  number Pasha Hawaii does not hold. A bot check, a redirect, an error page or an inquiry of
  another layout is not.
- A container's table goes back some months, over several shipments. It is cut into cycles at
  the empty container's release to a shipper, at a move under another booking or bill, and at the
  empty container's return. A container lookup returns the container's latest cycle, which may be
  a later shipment than the one asked about; the empty container's repositioning after its return
  is left out.
- A bill or booking returns, for each container, the cycle whose moves carry the bill or the
  booking. A shipment is delivered only once every container is back; until then the latest open
  stage leads.
- A move takes place where the container leaves, for a load, a departure or a gate out, or where
  it arrives, for a discharge, an arrival or a gate in. The empty container's return is the
  delivery once it left full or under its bill; returned before, it was not used. The empty
  container's repositioning has no stage. The wordings are in [statuses.json](statuses.json).
- Times are wall clocks. The zone comes from the place: its state, as `HONOLULU, HI`, or its
  port, as `LONG BEACH SSAPIER A` or `YOUNG BROTHERS HIL`.
- A bill's row shows its container's latest move under the bill, dated by its day. It stands in
  for a container whose table no longer holds the bill, and for the containers past the first
  three. A booking's row shows the container's latest move under any booking, so it is not read.
- The estimated departure and arrival, vessels, weights, holds and free days are not read.

## Limitations

- A bill or booking older than the container's table is known by its bill's row alone, and a
  booking's not at all.
- Vehicle tracking, and the container customer reference, party reference and container list
  searches, are not supported.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup; Pasha Hawaii's
own carry its `PGHU` owner code. Bookings are ten digits and bills of lading twelve. Detection has
no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/pasha-hawaii`, with `PASHA_HAWAII_TRACKING_NUMBER` and
`PASHA_HAWAII_UNKNOWN_NUMBER` set outside the repository.
