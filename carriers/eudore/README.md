# Eudore

Eudore (腾博物流) runs freight lines from its operation centre in Shenzhen, such as sea freight to
Amazon warehouses in the United States with delivery by truck. Tracked through its tenant (`tbwl`)
of the T6 platform (T6国际物流专线管理系统, by 深圳市跨境伙伴网络科技有限公司).

## How it works

1. `direct`: two form posts, as the tracking page at `https://tbwl.t6soft.com/track` sends them, with
   no cookie, token or CAPTCHA:
   - `POST /trackList` with the number in `searchList.waybillnumber`, the six number fields to search
     in `searchListField.waybillnumber` and `searchLang=zh`. The JSON lists the waybills found.
   - `POST /trackItem` with the waybill's `pkid` as `orderpkid` and its `waybillnumber`. The reply is
     the waybill's timeline as an HTML fragment.
2. `retry`: one more try when a request fails to reach the tracker or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- A number the tenant holds nothing under is `{"code":0,"data":[],"count":0}`, which is not found.
  Another `code` is inconclusive, and a redirect (to the login page) or a 404 is a moved route.
- The number asked must be one of the waybill's six number fields: the platform's system number, the
  shipper's reference, the waybill, the onward and replaced onward numbers, and the FBA shipment. When
  several waybills carry it, as the cartons of one FBA shipment can, it must be the shipper's
  reference or the waybill of exactly one; otherwise the reply is read as changed.
- The timeline must be the waybill's: its container is named `track-item-data-<waybill>`.
- The requests, checks and rows are the platform's, in [`t6.ts`](t6.ts), with the tenant's origin and
  wordings as parameters, so another T6 tenant needs only its own adapter and status map.

## Notes

- The rows give no zone, so each keeps its wall clock in `local_time` and is dated on its place's
  clock: a row in the United States on its state's (`NEW YORK, NY, US` on New York's), one in China on
  Beijing's. A row without a place is the platform's, on Beijing's clock. A place in a country of
  several zones with no state, one the gazetteer does not find, or a zone that would date the row
  after the read leaves the wall clock alone. The New York rows read as a working day there: the
  container picked up, unloaded and sorted over an afternoon, the truck out and delivered in a
  morning. On Beijing's clock all of it would have happened at night.
- The milestone strip above the timeline (入库 to 签收) repeats some rows' times and gives the moment
  the line marked a milestone for others, so only the timeline is read.
- The search also gives the delivery postcode, the FBA shipment id and the piece count. Only the
  destination country is kept. Rows drop that postcode, any FBA shipment id, a postcode in a place
  and whoever signed.
- The line's own wordings are in [`statuses.json`](statuses.json); a voyage delay names its new
  arrival date, which the map reads as an ellipsis. Other wordings go through the shared rules.

## Limitations

- No delivery estimate or weight. The proof-of-delivery files the search can link are not read.
- The search's onward number (`tracknumber`) names no carrier, so the result names no delivery
  carrier.

## Numbers

The only public sample is a shipper's reference, which says nothing about the line, so no rule
claims it and the adapter answers explicit selection. It and its source are in
[`numbers.json`](numbers.json).

## Testing

`EUDORE_TRACKING_NUMBER=… EUDORE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/eudore`
