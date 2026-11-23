# Marfret

Compagnie Maritime Marfret is the French container line. Tracked through the container tracker
that marfret.com frames, a page of Locus Software's Odyssey, for a container.

## How it works

1. `direct` opens a session of the tracker,
   `https://marfret-api.locussoftware.com/Odyssey/public/marfret/ContainerTrackSearch.seam`:
   - a GET of the page sets its session cookie and gives the view, `javax.faces.ViewState`;
   - a POST of the search form, as the page's search button sends it, with the
     `Faces-Request: partial/ajax` and `X-Requested-With: XMLHttpRequest` headers, answers with a
     JSF partial response holding the table of moves;
   - each later page of the table, past the first twenty moves, is asked with the search form
     again, since the table's own paginator answers with an empty table unless the search runs
     with it. Five pages at most are read, while the attempt has time.
2. A view the tracker no longer holds is answered with a redirect; the adapter opens one fresh
   session for it.
3. `retry` opens one more session when a request did not reach the tracker.

The tracker sits behind Cloudflare, which let the plain requests through. No account, CAPTCHA
or browser is needed.

## Notes

- Each row must name the container asked, and so must the header above the table. The table's
  message "No records found." under a reply of the expected layout is a container Marfret does
  not hold. A Cloudflare page, a redirect left after the fresh session, an error page or a table
  of another layout is not.
- The tracker lists the container's latest cycle alone: its allocation to a booking or its
  release from a depot, to its empty return. The table needs no cut.
- The tracker uses the same few wordings at every port, so a move is staged by where it falls in
  the cycle. Before the first load the container is booked and enters the terminal; an empty one
  gated into a depot then was not used. Loads, discharges and the moves between them are transit.
  After the last discharge a gate out is the consignee's collection and a gate in after it the
  empty return, which is the delivery. The wordings are staged in [statuses.json](statuses.json).
- Provisional moves, which the tracker lists apart with their planned dates, are not read as
  moves. A container the tracker names there or in its header, with no move, has no history yet.
- Times are wall clocks, which the page says are local. A place's UN/LOCODE, as `[AU MEL]`, gives
  the zone of its country when the country keeps one, or of the port for a few ports whose
  country keeps several. Spain's and Portugal's other ports keep their wall clock, since their
  islands keep clocks of their own.
- Vessels, voyages, the provisional dates, the container's ISO type, its description and its tare
  are not read.

## Limitations

- Only the container search is supported. The tracker also searches by booking, shipping
  instruction and bill of lading; no public number of those is known.

## Numbers

Containers are ISO 6346 numbers, whose check digit is checked before the lookup. Marfret's own
containers carry its `MFTU` owner code; leased containers answer too. Detection has no rule. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/marfret`, with `MARFRET_TRACKING_NUMBER` and
`MARFRET_UNKNOWN_NUMBER` set outside the repository.
