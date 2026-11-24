# 360Lion

Tracks 360Lion parcels by tracking number.

360Lion (纬狮物流), formerly Wish Global Logistics, is a Shenzhen operator of cross-border lines to
Latin America, delivering the last mile itself in Mexico. Its site is 360lion.com.

## How it works

`direct` reads the parcel from the service behind the public tracking page,
`toms.360lion.com/prod-api/toms/crossSite/oms/hawbcode/v2?codes=<number>`: no session, token or
browser.

The reply files the number under one of the page's groups (processing, pre-alert, in transit,
returned, delivered or not found) and lists its scans, newest first. Each scan has a code
(`WSD051`), 360Lion's English, the last mile's own wording, which the page shows, a country or
airport code and an icon naming its step on the page's route rail: hub, transport, airport,
customs, dispatch or delivered. A scan's description is the wording the page shows, and its
stage comes from its code, else from its rail step. Dispatch covers the whole last mile, so it
says in transit.

The group decides where the parcel stands. A parcel in transit takes a later stage its newest
scan states, such as customs. "Pre-alert", 预警 in Chinese, can be an advance notice or a
warning, so it sets no stage: the scans decide, and a pre-alert parcel without a scan that
says where it stands is a schema error, which leaves it to the universal providers. The page
files a parcel out for delivery under no group, and the reply then names none: its scans decide
the same way. A delivery under a newer scan neither its code nor its icon stages may have been
undone, so it no longer sets the stage.

Each scan states its place's offset in hours, "-3" in Argentina and "+8" at Pudong. The page
shows the wall clock alone; the adapter reads the wall clock with that offset, and rejects a
scan without one.

The reply lists the parcel by its number, and must list the requested one.

## Numbers

Archived lookups on its former tracker show WSH, a two-letter destination country, ten digits and
YQ, and a complaint about a SHEIN parcel that ProShips delivered in Colombia gives a number of the
same layout. The samples come from two sources, so the rule is low. The tracker also answers for
a destination country's two letters and ten digits. Detection offers 360Lion for AR and ten
digits, the layout its parcels to Argentina carry, with a low rule that Aramex's two letters and
ten digits share, and recognition asks the tracker. Other countries' letters stay unclaimed.

Parcels to Colombia also carry JTC and twelve digits. The tracker answers some of them with its
own scans and files others as not found, so a low rule offers 360Lion for the shape and
recognition asks the tracker.

## Limitations

The proof of delivery, the days in transit and the route rail's own position are never read,
though the page shows them.

A missing parcel is the not-found group for the requested number, without scans. An HTTP 404
is read as a moved service, never as a missing parcel. An error the service wraps in its own
code is a transport failure, or a rate limit when its message says the requests come too often.

ParcelsApp copies 360Lion's scans at their wall clock under the same codes, and reads them on
each place's clock.

## Links

The tracking page opens the number from its `trackNumber` parameter.

## Testing

`npm run test:carriers:live -- carriers/360lion`
