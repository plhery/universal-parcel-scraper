# GFS Express

GFS Express delivers online orders and collects cash on delivery in the Gulf, Saudi Arabia and
Kuwait among them, mostly for Chinese brands. Its tracker runs on the gateway of Fordeal's
group.

## How it works

`direct`: one GET of `dwp.silk.outerPackageTracking`, version 2, on `gw.gfsxpress.com/gw`, the
call [GFS's tracking page](https://track.gfsxpress.com/) makes.
- The query carries the number and the language as JSON, the clock in milliseconds, and an MD5
  signature of the call's name, version, data and clock with the salt the page's gateway
  script gives every browser. A call without it, or signed otherwise, comes back with code
  3012, read as a changed reply.
- The answer lists one record per number, under `trackingNo`. Only the record of the number
  asked is read. Its scans come newest first, each with an English wording and seconds since
  the epoch. Rows of one second keep the reply's order.
- A number GFS does not hold comes back as its echo alone, like one it has not been given yet,
  so it stays inconclusive (`portal_not_found`) and the enabled universal providers answer.
- `toCountry` is the destination's English name. `fromCountry` is not kept.

## Notes

GFS writes the import clearance in steps. "Customs Clearance Completed" and "Finished" end it;
"Customs Clearance Delivery" and "Parcel picked up from customs" follow as the parcel leaves
customs for GFS's warehouse. The map reads all four as transit, where the shared rules read the
last two as customs steps. "Data Registed" is GFS's spelling.

## Numbers

No public page shows a GFS Express number. A parcel GFS's own tracker holds, and universal
providers file under GFS, has `CGD` and eleven digits. No other carrier in the catalog writes
`CGD`, so `gfs-express-1` names GFS Express with high confidence. The corpus holds made-up
numbers in that shape.

GFS delivers AliExpress orders under these waybills, and Cainiao's tracker follows them from
China before GFS's first scan, with the export and flight legs GFS does not show. Detection lists
AliExpress in `origins`: while GFS holds only the label, the tracker asks Cainiao, and its movement
files the parcel under AliExpress with GFS proposed.

## Links

`track.gfsxpress.com/#/track-order?trackingStr=<number>` looks one number up, and the library reads
the number from that address.

## Testing

Set `GFS_EXPRESS_TRACKING_NUMBER` (and `GFS_EXPRESS_UNKNOWN_NUMBER` for the inconclusive answer)
outside the repository and run `npm run test:carriers:live -- carriers/gfs-express`.
