# Fixtures

Pages of Blackhaul's portal on Transvirtual's tracker at `/Track/654472/{number}`, without their
scripts, maps and analytics.

- `not-found.html`: the tracker's reply for a synthetic number: the empty form with "Missing or
  incorrect tracking number", under an id that repeats the number.
- `synthetic-delivered.html`: synthetic. No public Blackhaul number is known, so the page is
  built in the layout VT Freight Express's and Hunter Express's Transvirtual trackers serve for
  real consignments, on Blackhaul's portal: a consignment picked up, scanned into a depot, sent
  on a linehaul, out for delivery and delivered, with Western Australian clocks. Grouped scan
  rows carry their scans' UTC ticks in the address of their detail panel. The number,
  consignment id, suburb, postcode, receiver, places, coordinates, ticks and clocks are
  invented.
