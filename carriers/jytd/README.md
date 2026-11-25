# Jieyi Tongda

Tracks shipments of Jieyi Tongda (捷易通达, JYD, 深圳市捷易通达国际物流有限公司), a Shenzhen
cross-border forwarder whose site is www.jytd88.cn and whose line to Israel hands parcels to Israel
Post, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `123.207.50.250:8082`, where the site's tracking form, login and price links point, then, when
   the interface holds no row for the number, one POST of the same `documentCode` to the tracking
   page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The record's tracking number is the forwarder's own waybill. On the Israel line the record copies
  Israel Post's scans under it and names no other number, so nothing is handed on.
- The warehouse's rows, which carry a kind code, the order's rows, placed nowhere, and the export and
  departure rows placed in China or at Hong Kong's airport are on the platform's Beijing clock, which
  is Hong Kong's too. Rows placed abroad, Israel Post's copies and the landing at Tel Aviv, keep their
  wall clock: on Beijing's clock the postman units would receive the parcel before dawn in Israel.
- The interface replies in GBK, which cannot hold Hebrew: a row Israel Post words in Hebrew arrives
  as question marks alone and is dropped. The tracking page shows those rows in Hebrew.
- Israel Post's places end with a unit's or flight's code in brackets, which is dropped, and its
  eCommerce System, which writes the manifest and customs rows, is no place.
- Israel Post's receipt of the parcel's manifest and of the flight's cargo manifest are notices: they
  keep the stage of the scan before them.
- The record's product name is the service name and its destination the destination country.

## Limitations

Rows abroad keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's JYTD page. No detection rule claims a Jieyi Tongda
layout.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`JYTD_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/jytd`, with the number set outside
the repository. The unknown-number case asks for a number in a shape the tracker cannot hold, or
`JYTD_UNKNOWN_NUMBER` when set.
