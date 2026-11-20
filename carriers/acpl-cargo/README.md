# ACPL Cargo

Avinash Cargo Pvt. Ltd. (ACPL) is a road freight company of western India that carries
consignments between its branches across India. Tracked through the GC tracker on its website.

## How it works

1. `direct`: the adapter opens a guest session with `GET /bff/api/auth/session`, which sets a
   `bff.session` cookie, and looks the GC number up in it with
   `GET /bff/api/etrans?gcNumber=<number>`, as the tracking page's script does.
2. `retry`: a request that fails to reach ACPL Cargo, or hangs, is made again in a new session.

- The tracking form asks a sum before it looks a number up. The page works the sum out and checks
  the answer itself; the server never sees it, so the adapter does not ask it.
- A GC number the tracker does not hold answers `documentNoNotValid: FAIL`, which is not found.
  A reply with no booking and no such flag is inconclusive, and the booking and its details must
  name the number asked.
- A lookup refused for its new session is inconclusive.

## Notes

- Movements are staged by their wording. `Out for delivery` is not seen yet; the page's script
  looks for it to show the delivery run.
- The booking's own status settles a delivery the movements do not show yet: the tracker's
  script shows `Delivered` and the proof-of-delivery steps, such as `POD SUBMISSION DONE`, as
  delivered.
- Movement times have no zone, and every branch is in India, so they are read on India's clock.
- The booking's expected arrival date is the estimate until the consignment is delivered.

## Limitations

- GC numbers only. A number starting with `L`, which the page sends to a separate part-load
  lookup, is not taken: no public one has been found.
- No sender, recipient, signatory or proof of delivery. Addresses, packages, weight, the vehicle
  number and the booking's remark are not read.

## Numbers

A GC number is ten digits, as the example the tracker's form prints. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`acplcargo.com/tracking?gcNumber=<number>` opens one GC; the page also reads `gc` and `id`.

## Testing

`npm run test:carriers:live -- carriers/acpl-cargo` tracks the public sample in `numbers.json`;
`ACPL_CARGO_TRACKING_NUMBER` tracks another GC, and `ACPL_CARGO_UNKNOWN_NUMBER`, set outside the
repository, checks the not-found answer.
