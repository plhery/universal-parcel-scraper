# VYANG International

Tracks shipments of VYANG International (维央国际, 深圳市维央国际供应链有限公司), a Shenzhen
cross-border forwarder whose site is vyangexpress.com, on its own tenant of the Hualei (华磊)
forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `43.136.110.132:8082`, which the site's tracking link opens. For a number it holds nothing
   under, the tracker answers one record that only echoes the number as its reference; that reads
   as the no-row answer, and one POST of the same `documentCode` to the tracking page
   `trackIndex.htm` settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed.

## Notes

- Rows in China, placed there or nowhere, are on the platform's Beijing clock. From the flight's
  landing abroad on, the line's rows keep their wall clock: the tracker states no zone for them,
  and read on Beijing's clock the flight to Liège would take eight hours.
- The rows the tracker copies from DHL are on DHL's clock where DHL scanned the parcel: a town's
  when one is named, else Germany's or the destination's ([dhl-rows.ts](../gzyl/dhl-rows.ts)).
- The record's transfer number is the delivering carrier's, DHL's on the line into Germany, without
  a channel name. It is named only when DHL's rule claims the number whole.
- `Loaded to movement / tour vehicle` is DHL's wording for a trunk run and a delivery round alike,
  so the map reads it as in transit.
- The record's product name is the service name and its destination the destination country.

## Limitations

The rows at Liège keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's VYANG page. No detection rule claims VYANG's layout
yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`VYANG_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/vyang`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `VYANG_UNKNOWN_NUMBER` when
set.
