# Pass the Parcel

Pass the Parcel is Post Haste's online prepaid parcel service in New Zealand: senders buy packs
and boxes, each with its own tracking code, and the parcels travel on Freightways' networks.
New Zealand Couriers or Post Haste picks a parcel up and Post Haste delivers it. Tracked through
the Freightways lookup under Post Haste's name, with the group's tracker and parser
([freightways.ts](../nz-couriers/freightways.ts)).

## How it works

1. `direct`: one `GET https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/PostHaste/tracking-events?query={code}`,
   the code without its dashes. It needs no cookie, token, key or browser. The JSON reply is
   the consignment with its scans, oldest first.

- An unknown code, or a valid one not yet scanned, is an empty HTTP 204. A 404 or a redirect
  is a moved route.
- The reply's `shortConsignmentId` must be the whole code asked.
- Recognition is off: detection names the carrier for its codes.

## Notes

- The portal link opens Pass the Parcel's own tracker, `passtheparcel.co.nz/Pass/Track`, which
  checks the code at `/Send/ValidateBarcode` and posts it, with an antiforgery token from the
  page, to `/Pass/AjaxTrackTrace`. That HTML shows the same scans on the New Zealand clock; the
  Freightways lookup gives them as UTC instants with their scan types, so the adapter reads it.
- The lookup under Post Haste's name also holds Post Haste's tickets, labels and SSCCs. The
  adapter takes only a sixteen-character code, so it never answers for a Post Haste parcel.
- Each scan names the network that made it, but this one lookup shows the whole trip, so the
  network of the newest scan is not named as the delivery carrier
  (`namesDeliveryCarrier: false`). Post Haste's and New Zealand Couriers' adapters would refuse
  the code anyway.
- Scan types share New Zealand Couriers' status map. A transit delay notice has no code of its
  own there, and the wording rules read it as in transit.
- Signatures with the signatory's name, delivery photos, postcodes, branches, couriers and runs
  are not kept.

## Limitations

- A code the lookup no longer holds reads as not found.
- No weight or service.

## Numbers

Each pack and box carries a Parcel Tracking Code of sixteen letters and digits, printed in four
groups of four with dashes. The tracker's archived links and help pages give the samples, and
every one starts with 1RBB. The rule `pass-the-parcel-1` claims 1RBB and twelve letters and
digits with high confidence. It leaves out a code whose last fourteen characters are all hex
digits: Roadie's 1R and fourteen hex digits take those, and no Pass the Parcel code seen is one.
The adapter takes any sixteen letters and digits that do not start with a zero.

## Links

The tracker takes `?barcode=` with or without the dashes and looks the code up on load. Older
links on `/Customer/Track` redirect to it.

## Testing

`npm run test:carriers:live -- carriers/pass-the-parcel`, with `PASS_THE_PARCEL_TRACKING_NUMBER`
and optionally `PASS_THE_PARCEL_UNKNOWN_NUMBER` set outside the repository.
