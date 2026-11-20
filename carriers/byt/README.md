# BYT

Tracks shipments of BYT (上海佰邮通), a Shanghai forwarder whose site is byt56.com.cn, on its
own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
status map and row cleaning.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `tms.byt56.com.cn`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker's HTTPS host gives the same answers as the plain-HTTP port 8082 the site links to,
so the number never travels in the clear. No account, key, cookie, CAPTCHA or browser is needed. The
search box on the site's home page opens a page of placeholder rows, whatever the number, so no
portal link is published.

## Notes

- The forwarder writes its scans in English: warehouse receipt and departure, export centre,
  export clearance, the hand-over to the airline, the landing and import clearance. Many rows
  repeat their wording after `(中文:`, mostly in English again; the copy is dropped. Only the
  warehouse rows carry a kind code (`ARRIVAL`, `SHIPMENT`), and their place, "The carrier", is
  no place. The stage comes from the wording in [status.ts](status.ts).
- When the warehouse changes the last-mile carrier, a row gives the new number ("the new
  tracking number is …"). A number GOFO's own high-confidence rule claims whole becomes the
  delivery carrier's number, so GOFO can be asked for the last leg.
- Scan times are wall clocks without an offset on the platform's Beijing clock, as
  [GZYL's](../gzyl/README.md) are, and are read on it; a row dated after the lookup is held
  back.

## Limitations

The not-found reply comes from the platform's shared tracking page, not from a live lookup of an
unknown BYT number.

## Numbers

BYT's waybills are BYT and fourteen digits. The prefix is the forwarder's name and no other
carrier issues the layout, so the rule has high confidence. No public number has been found, so
the corpus holds a synthetic one.

## Testing

`npm run test:carriers:live -- carriers/byt`, with `BYT_TRACKING_NUMBER` and optionally
`BYT_UNKNOWN_NUMBER` set outside the repository.
