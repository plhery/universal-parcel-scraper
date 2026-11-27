# BFE Express

BFE Express delivers the last mile of online orders, many from marketplaces abroad, in Argentina,
Peru, Uruguay and the United States. Its site is bfeexpress.com.

## How it works

One bounded JSON POST asks the service the tracking page uses. The page signs each request with
a key its script gives every visitor: the UTC clock to the hundredth of a second, its MD5 with
the key, and the number encrypted with AES-256-CBC under that digest. The adapter signs the same
way. The service refuses a request signed about a minute away from its own clock and states that
clock in the refusal; the adapter then signs once more on it. Any other refusal is a schema error,
since it means the page signs differently.

The reply lists the shipment under the number asked, with BFE's status for it and its scans in
groups, by leg and carrier. A number BFE does not know comes back with the status `NotFound` and
stays inconclusive with the reason `portal_not_found`. A shipment listed without a scan, such as
one to Peru whose number is "being transferred", ends as no history with the reason `listed`.

## Notes

BFE's own rows are in English and start with their place, as "<place>, Arrived at Airport of
destination"; in Argentina they are in Spanish and start with the country. The adapter shows them
without that place, with it as the location and the whole row as `original_description`. A last
mile's rows, in Spanish in Uruguay, are kept as written, with the place as the location where the
wording says the parcel is there ("en"). The map reads both forms whole, the place included, so a
provider's copy reads the same. A row the map did not know is kept whole, place included; once its
wording is mapped, [identity.ts](identity.ts) lets the row stored that way keep its place in the
history.

Each scan states its offset, as "(GMT-03:00)", and keeps it. Scans follow the page's order
numbers, newest first. BFE's status `Delivered` decides the stage when the last scan's wording
is unknown. Its planned day is kept while the parcel is on its way and no scan is later. The
destination country is kept; postcodes and proof of delivery are left out.

## Numbers

Its contact form checks numbers by country: CK54 and twelve or thirteen digits in Argentina, CK512
and twelve digits in Peru, CK598 and twelve digits in Uruguay, WYB and nine digits in Peru, and two
nineteen-digit series in Argentina. Rules `bfe-express-1` and `bfe-express-2` suggest BFE Express
for the CK and WYB layouts, and recognition asks BFE's tracker about them. Universal providers name it BFE Express or, as 17TRACK does, BFE. Other
carriers print nineteen plain digits too, so nothing suggests BFE Express for those series.

## Links

Tracking links carry the number as `track_number` on the tracking page.

## Live test

Set `BFE_EXPRESS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/bfe-express/adapter.live.test.ts`.
Optionally set `BFE_EXPRESS_UNKNOWN_NUMBER` to check an inconclusive answer.
