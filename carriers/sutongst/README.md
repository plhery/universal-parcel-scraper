# Sutong International Express

Sutong International Express (香港速通国际快运, 香港速通国际物流, sutongst.com), a Hong Kong firm working from
Shenzhen, sends parcels from Shenzhen to the US and Canada. It is not [Suto Logistics](../suto-logistics/README.md)
(速通物流, sut56.com), a different firm on another host. Tracked through the route its tracking page asks.

## How it works

1. `direct`: one `GET https://www.sutongst.com/API/Express/?id=SUTONG&com=88889&nu={number}`, as the page
   `/list-1793.html` sends it. `id` and `com` are fixed hidden inputs on that page. It needs no cookie, token or
   account.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget.

- `LatestState` NotFound with `status` 0 and no rows is the tracker's answer for a waybill it does not know, which
  is not found. Any other reply without rows is inconclusive. HTML is a browser check or a changed route, and a
  non-200 reply is a moved route or a request the site refuses.
- The reply does not repeat the number; the not-found answer for an invented waybill is distinct, so a list of
  rows is read as the waybill asked.

## Notes

- `time` is a wall clock with no zone, and each `context` starts with its place, 【深圳】 or [California]. A place
  in China written in Chinese is dated on China's clock, a US state or a Canadian province on the zone the library
  gives it, each with `place` as the basis. A leg between two places, such as 【中国-US】, and a place that names
  no one zone keep their wall clock alone. Ontario is one: it is the Canadian province and also the Californian
  city with the carriers' hubs, and the sample's rows before it are Californian.
- `LatestState` stays InTransit after the delivery, so the stage comes from the rows. `statuses.json` records each
  text with its place as 【…】, in either bracket.
- The delivery row goes on to name the signer; that clause, and any phone a row gives, is taken out.
- `localCarrier` and `localNumber` become the delivery carrier and its number when they name a North American
  courier the catalog has and its rules offer the number. The public sample fills them with placeholders, which
  name no one.
- `toCountry` gives the destination country when it names one; otherwise the first US state or Canadian province
  a row names does.

## Limitations

- No public sample shows a hand-off to a local courier or a parcel to Canada.
- The page reads the number from the window that opened it, so the catalog gives no tracking link.
- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Sutong's waybills seen so far are ST and twelve digits, a shape no other carrier's rule or sample takes, so
detection offers Sutong for it as a candidate at low confidence. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/sutongst` tracks the public sample, or the number in
`SUTONGST_TRACKING_NUMBER`, and checks an invented waybill, or the one in `SUTONGST_UNKNOWN_NUMBER`, reads as not
found.
