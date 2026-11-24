# Obibox

Obibox delivers e-commerce parcels in Quebec and Ontario. It began as Xpedigo, whose tracker
links still lead to Obibox's. It collects parcels from the shops and delivers them.

## Numbers

Numbers start with `XP`, a three- or four-letter shipper code and the shipper's order
reference, and end with the package's index after `_` (until early 2025) or `Q`. Archived
lookups on its tracker show the layout across eight shipper codes and no other carrier prints
it, so `obibox-1` names Obibox with high confidence. The adapter takes 8 to 40 letters, digits
and underscores, as the tracking links carry them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://api.obibox.io/shipment_tracking/public/shipment_tracking?tracking_number={number}&_force=1`,
   the request the tracking page's script makes, with its `X-Requested-With`, `X-Force-Refresh`
   and no-cache headers. It needs no session, token or cookie. The script also adds random
   cache-busting values, which the adapter leaves out.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of it.

The reply holds one milestone per step the parcel reached, each with a copy of the shipment that
repeats the number, and the scans. The adapter keeps a reply only when every copy repeats the
number asked. Each scan has a status code, an English description and an instant in UTC; the
page words a scan from its code alone, and the adapter keeps the description.

The shipment carries the recipient's name and address, the shop's address, the delivery
instructions, the order number and map positions, and the milestone of a parcel out for
delivery the driver's position. The adapter never reads them. It does not read a scan's place
either: the page fills that slot with the recipient's address for a delivery's steps. It keeps
the shop's name as the sender.

A number the tracker holds no parcel under gets HTTP 404 with "No Parcel Found" and the code
12001, read as not found; it does not repeat the number, and the stateless request binds it.
Any other 404, such as the gateway's for a missing route, a redirect or a gone route is a
transport failure. A browser check is a challenge, refusals, rate limits and outages keep the
transport's kinds, and a page in place of the JSON is a changed reply.

There is no recognition: `obibox-1` names Obibox alone, so preflight has nothing to settle.

## Status

Scans are staged by their code, and an unknown code by its description through the shared
wording rules. The newest staged scan sets the parcel's stage; a reply without scans stands on
the shipment's current status, as a summary, when the map knows it. The map holds the sample's
codes and those the page's script names. A shipment ready again after its collection is a
delivery put off for later; the shared rules read that registration as in transit.

## Estimate

As the page does, a parcel collected or out for delivery gets the delivery window of its
milestones, two instants with their offsets, and a parcel before its collection the shipment's
delivery date as a day. A delivered parcel has none. The driver's time and distance away,
which the page counts from the moment it asks, is named as an unread estimate.

## Clocks

Every scan and window states its offset, so the results carry instants; the catalog's Toronto
zone, which covers Quebec and Ontario, is only the carrier's home zone.

## Limitations

- The tracker keeps about six months of parcels; older numbers read as not found.
- No scan places, weight, service or proof of delivery.

## Links

The trackers keep the number as the whole path.

## Testing

```sh
npm run test:carriers:live -- carriers/obibox
```

It reads the newest public sample from `numbers.json`; `OBIBOX_TRACKING_NUMBER` and
`OBIBOX_UNKNOWN_NUMBER` set outside the repository replace the sample and the synthetic unknown
number.
