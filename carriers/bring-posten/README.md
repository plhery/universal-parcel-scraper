# Bring / Posten Norway

Tracks consignments, their pieces and Norwegian S10 postal parcels through the
current anonymous consumer service. A consignment number with several pieces is
inconclusive; each piece's own number still tracks that piece.

## How it works

One bounded GET reads the JSON route published by the
[consumer portal](https://sporing.bring.no/sporing/). The consignment or parcel
identifier must match exactly. A parcel's SSCC typed with its 00 identifier is
asked as the 18-digit parcel number, which the result reports. This route is
separate from the authenticated
[developer API](https://developer.bring.com/api/tracking/).

## Notes

Current progress follows the latest significant scan identified by the portal,
which a newer delivery change notice can sit above. Notifications and delivery
changes remain in history without a stage. Return transport and completed return
use different codes. A parcel handed in after the day's deadline reads as
accepted; other deviations are exceptions. Per-scan offsets establish instants;
incomplete clocks remain local evidence.

The sender the portal names, usually the shop, and the destination country are
kept. The pickup point is named while the parcel waits there. The estimated day
is kept while the parcel travels and the portal marks the estimate available.

Status wording comes from public event and cause codes. Free-text descriptions,
addresses, pickup codes and proof images are excluded. Weight and dimensions have
explicit units. The consumer's unbound negative response remains inconclusive.

## Live test

Set `BRING_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/bring-posten/adapter.live.test.ts`.
Optionally set `BRING_UNKNOWN_NUMBER` to check the inconclusive absence response.
