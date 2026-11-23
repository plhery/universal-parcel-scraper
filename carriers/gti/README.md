# GTI

Tracks shipments of GTI (跨境易通, 深圳市跨境易通供应链管理有限公司), a Shenzhen forwarder whose
site is gti56.com, on its own tenant of the Hualei (华磊) forwarder platform. Its US line flies
parcels from China to the United States, where USPS delivers them, and the tracker
copies USPS's scans into its own record. The client is shared with [GZYL](../gzyl/README.md),
whose README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `gti568.com:8082`, then, when the interface holds no row for the number, one POST of the same
   `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The site's customer sign-up points to this tenant, which serves the forwarder's GTI numbers.
  The site also links a NextSLS tracking page; the Hualei record carries the forwarder's own
  rows and USPS's, so the adapter reads that.
- The forwarder's own rows are its warehouse's receipt (`ARRIVAL`) and departure (`SHIPMENT`),
  mapped in [status.ts](status.ts). The platform adds a script of rows from the airport to
  customs (`CO_C_CR`), which are named as written ahead rather than kept as scans.
- The rows copied from USPS are read as [Kun Express](../kun-express/README.md) reads its own
  copies: the place they lead with and USPS's explanation after an arrow are cut, a wording
  that ends with another's at one clock and place counts once, ZIP codes go, and rows to the
  minute keep USPS's wall clock while the forwarder's rows, to the second, are on Beijing time.
  Some copies lost their spaces to question marks; the spaces come back, so those copies merge
  with the others. A copied row with no wording but its place is dropped.
- The record's product name is the service name. The tracker also finds a parcel by the
  shipper's reference, and then names the GTI number.

## Limitations

The record gives no delivery estimate, weight or USPS number. Its history goes only as far as
the forwarder has copied USPS's scans.

## Numbers

The only public number is a tracking app's format example: GTI and thirteen digits. One sample
is too few to tell the series from other carriers' numbers, so no rule claims it and the adapter
answers explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP, so no portal link is published, and the canary checks 17TRACK.

## Testing

`GTI_TRACKING_NUMBER=… GTI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gti`
