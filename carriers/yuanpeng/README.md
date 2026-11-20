# Yuanpeng Supply Chain

Tracks shipments of Yuanpeng Supply Chain (远朋, 深圳市远朋跨境供应链有限公司), a Shenzhen
forwarder whose site is yuanpeng56.com, on its own tenant of the Hualei (华磊) forwarder platform.
Its US lines fly parcels from Shenzhen to New York, where USPS delivers them, and the tracker
copies USPS's scans into its own record. The client is shared with [GZYL](../gzyl/README.md),
whose README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.yuanpeng56.com:8082`, then, when the interface holds no row for the number, one POST of
   the same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder's own rows are its Shenzhen warehouse's receipt (`ARRIVAL`) and departure
  (`SHIPMENT`), mapped in [status.ts](status.ts). The platform adds a script of rows from the
  airport to customs (`CO_C_CR`), which are named as written ahead rather than kept as scans.
- The rows copied from USPS are read as [Kun Express](../kun-express/README.md) reads its own
  copies: the place they lead with and USPS's explanation after an arrow are cut, a wording
  that ends with another's at one clock and place counts once, ZIP codes go, and rows to the
  minute keep USPS's wall clock while the forwarder's rows, to the second, are on Beijing time.
- A row names the USPS number as `Last Mile Tracking Number …`; the result gives it with USPS as
  the delivery carrier, as USPS's own rule claims it.
- The record's product name is the service name. The tracker also finds a parcel by the
  shipper's reference, and then names the YP number.

## Limitations

The record gives no delivery estimate or weight. Its history goes only as far as the forwarder
has copied USPS's scans.

## Numbers

The only public number is a directory's sample: YP, ten digits and two letters. One sample is
too few to tell the series from other carriers' numbers, so no rule claims it and the adapter
answers explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP, so no portal link is published, and the canary checks 17TRACK.

## Testing

`YUANPENG_TRACKING_NUMBER=… YUANPENG_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yuanpeng`
