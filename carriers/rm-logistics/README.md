# RM Logistics

Tracks shipments of RM Logistics (荣贸, 金华市荣贸供应链管理有限公司), a Jinhua forwarder whose
site is jhrm56.com, on its own tenant of the Hualei (华磊) forwarder platform. Its lines fly
parcels from Yiwu to the United States, where a local carrier delivers them; the tracker copies
their scans into its own record. The client is shared with [GZYL](../gzyl/README.md), whose
README describes the platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `129.211.2.64:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- [status.ts](status.ts) maps the Yiwu warehouse's receipt (`ARRIVAL`, worded in Chinese), the
  hub transfer and the US warehouse's pickup; the other English rows go through the shared rules.
- Rows keep their wall clocks: they come from Yiwu, the airports and the delivering carrier's
  facilities. Places drop ZIP codes.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over. The tracker also finds a parcel by the shipper's
  reference, and then names the RM number.

## Limitations

The delivering carrier and its number are never shown. No delivery estimate or weight.

## Numbers

The only public number is a directory's sample: two letters, thirteen digits and TM. One sample
is too few to tell the series from other carriers' numbers, so no rule claims it and the adapter
answers explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP on a bare address, so no portal link is published, and the
canary checks 17TRACK.

## Testing

`RM_LOGISTICS_TRACKING_NUMBER=… RM_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/rm-logistics`
