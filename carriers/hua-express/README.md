# HUA Express

Tracks shipments of HUA Express (华联万通, 华联万通国际供应链(深圳)有限公司), a Shenzhen
forwarder whose site is huaexpress.com, on its own tenant of the Hualei (华磊) forwarder platform.
Its US lines fly parcels from Shenzhen through Hong Kong to New York, where a sorting partner and
then a local carrier deliver them; the tracker copies their scans into its own record. The client
is shared with [GZYL](../gzyl/README.md), whose README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `159.75.210.47:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- [status.ts](status.ts) maps the Shenzhen warehouse's receipt (`ARRIVAL`) and departure
  (`SHIPMENT`), and the US sorting partner's receipt, which names its facility by a code such as
  `NJC01`. The other English rows go through the shared rules.
- Rows keep their wall clocks: they come from Shenzhen, Hong Kong, New York and the delivering
  carrier's facilities. Places drop ZIP codes.
- A row written well before its own clock, such as the flight's departure, is named as written
  ahead rather than kept as a scan.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over. The tracker also finds a parcel by the shipper's
  reference, and then names the HUA number.

## Limitations

The delivering carrier and its number are never shown. No delivery estimate or weight.

## Numbers

The only public number is a directory's sample: HUA, nine digits and two letters. One sample is
too few to tell the series from other carriers' numbers, so no rule claims it and the adapter
answers explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP on a bare address, so no portal link is published, and the
canary checks 17TRACK.

## Testing

`HUA_EXPRESS_TRACKING_NUMBER=… HUA_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/hua-express`
