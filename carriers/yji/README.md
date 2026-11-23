# YJI

Tracks shipments of YJI (延锦国际, 延锦国际物流货运代理有限公司), a Chinese forwarder whose site is
yanjin-gj.com, on its own tenant of the Hualei (华磊) forwarder platform. Its US sea line carries
parcels from its Guangzhou warehouse to the United States, where FedEx delivers them, and the
tracker copies FedEx's scans into its own record in FedEx's Chinese. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `yanjin-gj.com:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder's own rows are its warehouse's receipt (`ARRIVAL`, worded as a post's arrival at
  an office of exchange) and departure (`SHIPMENT`), and its notes on the voyage, marked `【CN】`
  and `【US】`, mapped in [status.ts](status.ts). They come on the platform's Beijing clock.
- The platform also writes a script for the voyage (`CO_C_CR`) all at once, on its own timetable,
  days before the forwarder's notes give the real sailing and arrival. The shared client names
  those rows as written ahead rather than keeping them as scans.
- The rows copied from FedEx are placed as `US,<state>,<town>` and keep FedEx's wall clock. The
  adapter writes the place as the town and its state and dates the row in the state's zone,
  saying it chose the zone by place. FedEx's label row names only the country and keeps its wall
  clock alone.
- The record's product name is the service name.

## Limitations

The record gives no delivery estimate, weight or FedEx number. Its history goes only as far as the
forwarder has copied FedEx's scans. A state on two zones is read on its main one.

## Numbers

The only public number is the sample a tracking app's archived carrier page embeds: YJID, a
letter, ten digits and YQ. One sample is too few to tell the series from other carriers'
numbers, so no rule claims it and the adapter answers explicit selection. The sample and its
source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP, so no portal link is published, and the canary checks 17TRACK.

## Testing

`YJI_TRACKING_NUMBER=… YJI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/yji`
