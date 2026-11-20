# BFE Express

BFE Express parcels use enabled universal providers. There is no dedicated adapter.

BFE Express delivers the last mile of online orders, many from marketplaces abroad, in Argentina,
Peru, Uruguay and the United States. Its site is bfeexpress.com.

## Numbers

Its contact form checks numbers by country: CK54 and twelve or thirteen digits in Argentina, CK512
and twelve digits in Peru, CK598 and twelve digits in Uruguay, WYB and nine digits in Peru, and two
nineteen-digit series in Argentina. Rules `bfe-express-1` and `bfe-express-2` suggest BFE Express
for the CK and WYB layouts; a universal provider named BFE Express for a CK54 parcel. Other
carriers print nineteen plain digits too, so nothing suggests BFE Express for those series.

## Why there is no adapter

The tracking page encrypts the numbers it sends to an open JSON service with a key in its script.
No public number has shown a known parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `track_number` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
