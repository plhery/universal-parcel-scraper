# Fixtures

Synthetic replies of PXC's `api/v1/Tracking/Tracking` lookup, shaped like its answers for the
public samples in [`numbers.json`](../numbers.json). The air waybills, the partner's numbers,
the names, reference, weight and manifest are invented, a suburb is replaced with its city and
the dates are moved back a year.

- `delivered-new-zealand.json` goes from PXC's hub in Mumbai through Kuala Lumpur and New
  Zealand's customs to delivery by DTDC Australia, after days on hold at its branch.
- `customs-australia.json` stops while Australia's customs holds the parcel, and names an
  invented partner link to Australia Post to cover the hand-off to a catalog carrier.
- `not-found.json` is the answer for a made-up number of the same shape.
