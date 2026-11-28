# Fastgo

Fastgo (速派快递), run by Fastgo Pty Ltd from Brisbane with a Shanghai trading company, carries parcels from
Australia and New Zealand to China, clears them through customs and hands them to EMS for delivery. Its
consolidation service, 速派集运 or 随意邮, ships shoppers' parcels from China to Australia, Japan and the United
States. Its site is fastgo.com.au. Fastgo Express in Canada, at fastgoexpress.com, carries the brand from Canada
to China.

## How it works

`direct` posts the waybill to the route API behind the tracking page, `api.fastgoexp.com/api/route/getRoutes`,
as the page's indexed `billIds` list: no session, token or browser. The reply lists the waybills it holds, and
only the one whose `number` is the whole waybill asked is read.

The page asks the one-waybill route, `GET /api/route/{number}`, for a single number. That route answers a
waybill it no longer holds and a failure alike, with code `9999` and an unknown error, while the list leaves the
waybill out. The page reads a waybill left out of the list as not existing, so the adapter asks the list.

Each scan is a Chinese text and a clock without a zone. The scans come from Fastgo's warehouses and from customs
in China, so each keeps its wall clock. The texts are staged by `statuses.json`, else by the shared wording rules.

The waybill names the courier of the last leg, `expressalias`, and its number, `expressno`. The number is kept as
the delivery number. EMS becomes China Post, and 顺丰速运 SF Express, as the delivery carrier only when that
courier's own rules take the number; China Post's do not take the 13-digit domestic EMS numbers.

## Numbers

The one public example, an archived reply of its own route API, is `AU`, nine digits and `SG`: shaped like an S10
number, but its S10 check digit does not fit. `fastgo-1` suggests that layout at low confidence, as it is the only
example. A number of that shape whose S10 check digit happens to fit stays with Singapore Post's rule. The adapter
takes any waybill of letters and digits, as the tracking page does.

## Limitations

A waybill the list leaves out is not found; any code but `0000`, or a reply that is not JSON, is a failure. The
reply's `issign`, `deliverystatus` and each scan's `flag`, which the page does not show, are not read. The
scans name no place.

The public example has expired from the API, so no found reply has been seen on the current host; the parser
reads the archived reply of the older host, api.fastgoexpress.com, whose objects the page reads in the same
fields.

## Links

The tracking page opens numbers from its `bill` parameter; `from=bs` hides the page header.

## Testing

`FASTGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/fastgo`
