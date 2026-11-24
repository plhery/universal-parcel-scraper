# Zhongzhou Logistics

Tracks shipments of Zhongzhou Logistics (中洲物流, 莆田市中洲物流供应链有限公司, Putian Zhongzhou
Logistics Supply Chain), a Putian cross-border forwarder whose site is zhongzhouwuliu.com.
[ParcelsApp](https://parcelsapp.com/en/carriers/zzwl-cn) lists it as ZZWL.

## How it works

The site's tracking page frames Zhongzhou's own tenant of the Hualei (华磊) platform. Its HTTPS
certificate has expired; the tenant answers the same over plain HTTP at `zhongzhouwuliu.com:8082`.
The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts)) with this carrier's host and status
map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The site also links the rtb56 tenant that [Muser's](../muser/README.md) adapter reads. That tracker
does not hold the parcels Zhongzhou's own tracker answers, so the adapter does not ask it.

## Notes

- A record keeps Zhongzhou's own number as its tracking number. The interface also finds the record
  by GOFO France's number for the parcel, which the record holds in no field. The adapter takes such
  a lone record only when the number asked is one GOFO France's rule claims whole (`partnerNumbers`
  in the shared reader); the result then names GOFO France for the last leg under that number and
  gives Zhongzhou's number as the canonical one.
- The tracker writes most rows in Chinese and English in one row, and some twice at one clock, once
  in each language. The adapter shows the English and keeps one row of each pair. Rows written in
  Chinese only show the English the platform's other tenants give them.
- A booked flight and its delay are notices: they keep the stage of the scan before them.
- Rows from abroad come on clocks the record does not name, so every row keeps its wall clock.

## Limitations

- Asked by Zhongzhou's own number, the result names no delivery carrier: the record keeps GOFO's
  number nowhere.
- GOFO France is the only delivery carrier seen; another line's carrier is not named.
- The tracker copies GOFO's label row twice, hours apart. Both copies are kept, as the record names
  the zone of neither.

## Numbers

Zhongzhou's own numbers are `ZZ`, ten digits and `CN`. No public source shows one, so there is no
detection rule and the corpus holds no sample. Detection never offers the carrier: parcels reach it
by an explicit carrier or a universal provider's carrier name.

## Links

The tracker answers over plain HTTP only, so the catalog links no page of it. The canary takes
HTTPS only, so it checks 17TRACK, which the site links to.

## Testing

Set `ZHONGZHOU_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/zhongzhou-logistics`. The not-found case asks an invented
number, or `ZHONGZHOU_LOGISTICS_UNKNOWN_NUMBER` when set.
