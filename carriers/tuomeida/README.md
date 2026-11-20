# Tuomeida Logistics

Tracks shipments of Tuomeida Logistics (拓美达, 深圳市拓美达国际物流有限公司), a Shenzhen
forwarder whose site is tuomei-express.com, on its own tenant of the Hualei (华磊) forwarder
platform. Its US lines fly parcels from Shenzhen to the United States, where USPS delivers them,
and the tracker copies USPS's scans into its own record. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `114.132.187.44:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- The forwarder's own rows are its Shenzhen warehouse's receipt (`ARRIVAL`) and departure
  (`SHIPMENT`), export clearance, the flight and import clearance, in English. [status.ts](status.ts)
  maps the warehouse rows and USPS's `No Such Number`; the rest go through the shared rules.
- Rows keep their wall clocks: the forwarder writes rows from China and the United States alike,
  and USPS's come on the facility's clock. Places drop ZIP codes.
- A row the platform scripts ahead of its clock (`CO_C_CR`) is named as written ahead.
- The record's product name is the service name. Records name no channel or transfer number, so
  no USPS number is handed over. The tracker also finds a parcel by the shipper's reference, and
  then names the TM number.

## Limitations

The USPS number is never shown, so the history goes only as far as the forwarder has copied
USPS's scans. No delivery estimate or weight.

## Numbers

The only public number is a directory's sample: TM and thirteen digits. One sample is too few to
tell the series from other carriers' numbers, so no rule claims it and the adapter answers
explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP on a bare address, so no portal link is published, and the
canary checks 17TRACK.

## Testing

`TUOMEIDA_TRACKING_NUMBER=… TUOMEIDA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/tuomeida`
