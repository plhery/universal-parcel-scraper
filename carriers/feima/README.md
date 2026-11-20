# Feima

Tracks shipments of Feima (飞马物流), a Chinese forwarder that brands itself FINMA PEGASUS and
whose site is finmaship.com, on its own tenant of the Hualei (华磊) forwarder platform. The client
is shared with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps
its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `47.111.22.87:8082`, whose page the site's tracking form opens, then, when the interface holds
   no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- The tracker writes a record's timeline in one go, the first row after its clock and the others
  days or weeks ahead of theirs, from the pick-up to the courier at the destination. A row written
  well before its own clock is named as written ahead rather than kept as a scan, so the record
  moves only as its clocks pass the moment each row was written.
- Rows name their place, "US" or a country code and town, and often repeat it at the head of the
  wording; the wording is read without it. Their clocks are on the platform's Beijing time, abroad
  too, and are read on it.
- [status.ts](status.ts) maps the last row at the destination, "Shipping by courier": the parcel
  goes on with a courier the tracker does not name, which is not a delivery attempt. The other
  English rows go through the shared rules.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over.
- 17TRACK names the forwarder FEIMA, 飞马物流 and 飛馬物流, which are kept as names.

## Limitations

The delivering carrier and its number are never shown. No delivery estimate or weight.

## Numbers

The tracker holds waybills of FM, ten digits and CN, which no other carrier issues, so that rule
has high confidence. A customer's public question gives a number of FM, nine digits and CN under
Feima's name, in UPU's layout but with a check digit UPU's rule rejects. The tracker no longer
holds it, so that shape only suggests Feima, and recognition asks the tracker about it. The corpus
holds that sample and a made-up number in the ten-digit shape.

## Links

A link to the tracker's page with the number in its `documentCode` parameter names Feima. Since the
tracker is plain HTTP on a bare address, no portal link is published, and the canary checks
17TRACK instead.

## Testing

`npm run test:carriers:live -- carriers/feima`, with `FEIMA_TRACKING_NUMBER` and optionally
`FEIMA_UNKNOWN_NUMBER` set outside the repository.
