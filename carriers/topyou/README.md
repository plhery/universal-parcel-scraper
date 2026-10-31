# TopYou

The `topyou` adapter reads TopYou's own tracker for its waybills.

TopYou is 深圳市通邮物流科技（集团）股份有限公司 (通邮集团), a Shenzhen cross-border forwarder with
international lines, whose site is szty56.com.

## Numbers

Its waybills are TYZR, a letter, ten digits and YQ. Forwarders on the Hualei (华磊) platform end
their waybills with YQ and open them with their own code, as [Juxi Express](../juxi-express/README.md)
does. A sample on ParcelPanel's TopYou page and a parcel a universal provider files under TopYou
share the layout, TopYou's own tracker answers the sample, and no other carrier's rule takes it, so
`topyou-1` has high confidence.

## Retrieval

`track.szty56.com` posts `{"ids": [number]}` to `/order/track` and gets JSON without a token or
session: one entry per number with its scans, oldest first, each with a clock, an offset, a status
code and an English wording. The adapter sends the waybill in capitals, since the tracker matches
it case for case, and reads the entry that echoes it.

TopYou's own scans carry `+08:00`. The delivery carrier's scans it relays, USPS's in the United
States, come without an offset and keep their wall clock, which their place dates. GOFO's in France
and Italy come with the destination's offset on a UTC wall clock: stated `+01:00`, each came an hour
before GOFO's own instant for it and showed twice beside GOFO's scan, so a relayed scan's clock
other than `+08:00` is read as UTC. A reply with no
scans and no destination is the page's "查询不到" (not found); one with a destination and no scans
is an order announced but not received, and `success: "false"` is the page's "暂无轨迹信息" (no
tracking yet): both are known numbers without history.

A scan's wording in [statuses.json](statuses.json) gives its stage first; a delivered (30) or
returned (40) code settles it next, then the shared wording rules, then the code. Code 15 covers
the delivery carrier's scans up to the delivery, out for delivery included, so it says only that
the parcel moves, and USPS's acceptance after the flight is no first acceptance. "Shipment is out
for delivery" is the hand-over to GOFO, at GOFO's first sorting-centre scan days before its
delivery round, so it is transit. The tracker's
summary code settles a delivered or returned parcel.

TopYou's own scans name the destination country even at the origin airport, so a place that is
only countries is left out of them. A wording loses a closing "of" whose country the tracker left
empty. `transferNo` is the delivery carrier's number, reported as `delivery_tracking_number`.
`carrierCode` names TopYou's own line rather than that carrier (a parcel USPS delivered came under
"DHL Paket"), so the adapter names no delivery carrier. The tracker also finds a parcel by its
transfer number, but the adapter takes TopYou's waybills only.

## Links

The tracker reads the number from its form only, so no link opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/topyou`, with `TOPYOU_TRACKING_NUMBER` and optionally
`TOPYOU_UNKNOWN_NUMBER` set outside the repository.
