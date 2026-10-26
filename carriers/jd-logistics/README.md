# JD Logistics

Tracks international waybills through the official international website's anonymous feed.
Chinese domestic waybills use a separate service and can fall back to enabled universal providers.
Detection still selects JD Logistics for them: JD followed by thirteen characters, of which at
most the first two are letters, as in the JDV and JDX series.

## How it works

One JSON POST queries the website's international tracking proxy. The parent reference must
match the requested number and contain one waybill with dated scans. Multiple pieces are
rejected because selecting one could return another parcel's progress.

Each scan keeps its operation code as its provider code and takes its stage from it
(`status.ts`); a scan with an unknown code is classified by its wording. An order shipped from
JD's own warehouse abroad is accepted there while it is picked and weighed, then handed to a
last-mile partner such as GOFO, whose steps JD relays. GOFO's label comes under a code JD has
shown with that step alone, and GOFO's loading at a hub, before its delivery station, under the
code of JD's courier out with the parcel, so their wording decides them rather than the code.
The newest scan decides the status. The courier's name and phone are dropped from the out-for-delivery wording
(`wording.ts`).

A scan's location is its city and its country in English. JD names the country in Chinese in
`routeCountry` on some scans, by its full name or a usual short form, and in English in
`routeProvinceName` on its international lanes, so either gives the same name. A country read
neither way stays as written; a province adds nothing. A city that is the country itself, such
as Hong Kong, Macau or Singapore, stands alone.

Each scan's wall clock is local to the scan, whatever zone the request names. A scan also
carries epoch milliseconds and a declared fixed offset (`UTC+3`). It is dated, in that offset,
only when the epoch reads as its wall clock there. Every country its place fields name must
also have a single zone known here, and that zone must keep that offset at that wall clock,
neither skipping nor repeating it. Beside the shared single-zone table, the parser knows Saudi
Arabia, Kuwait, Qatar, Bahrain, Oman, Egypt and Macau, so a Saudi scan is dated at +3 and
stays local at +8. A country spanning several zones (United States, Australia, Indonesia,
Brazil), one not known here, or a country field read neither way keeps the clock local. So does
a place naming no country read here, such as a Chinese province and city without a country or
an abbreviation like `KSA`. Only a scan with no place at all, such as the order's creation, is
dated on its epoch and declared offset alone. A fully dated history is ordered by instant, ties
in JD's order; any local clock keeps JD's order, newest first.

## Limitations

Chinese domestic waybills, such as the JDAZ series, answer an empty list here. An empty answer
is inconclusive with the reason `portal_not_found`: JD's own answer, not an outage, and no proof
that the parcel does not exist. Domestic tracking on jdl.com (`api.jdl.com`,
`waybillQuery/needVerify` then `waybillQuery/trackWaybill`) shows JD's click captcha before any
history. A scan without an epoch is not dated from its declared zone alone. Proof-of-delivery
images and recipient verification are excluded.

## Testing

Set `JD_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jd-logistics/adapter.live.test.ts`.
