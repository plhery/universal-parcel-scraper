# Alphastline

Alphastline (傲飞国际快线, Alphast) is a Chinese cross-border express line run by DSers, the
dropshipping platform. Its site is alphastline.com and its contact address is on dserspro.com.
Tracked through the tracking form on its home page.

## How it works

1. `direct`: `POST https://alphastline-api-gw.dsers.com/dsers-logistics-bff/v1/tracking/query` with the
   JSON the home page's form sends: `language: "en"` and the number in `erpOrderCode`. It needs no
   cookie, token, CAPTCHA or browser.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply lists one entry per order asked under `trackingData.All.arr`: the order's number
  (`erpOrderCode`), its status, the countries it ships from and to, the line's number once it has one
  (`mailNo`) and the scans, each a wall clock, its instant in epoch seconds, a wording and a node. The
  entry must name the whole number asked.
- A number the tracker has nothing for has no scans, the status `Default` and "Unable to find" in
  `errMsg`. Only that answer is not found. Another `errMsg` without scans is inconclusive, a redirect
  or a 404 is a moved route, HTTP 403 or a browser check is a challenge, and a reply that is not the
  expected JSON is a schema failure.
- The same query answers on `api.alphastline.com`, the production host of Alphastline's developer
  API, behind CloudFront. The form's host is in mainland China.

## Notes

- The registration agreement forbids scraping platform data, but it binds those who register or
  log in to the platform. The tracking form needs no account.
- Each scan gives its wall clock and its instant. Its time is that instant on the offset the two give
  together, Beijing time in the scans seen. When they give no zone's offset, the instant is kept in UTC;
  a scan with only its wall clock is read on Beijing time.
- The map stages scans by their node: `Created` is the order's data received,
  `PickedUp_CollectedParcel` the collection, and `InTransit_Other` the sorting centre's scans, the
  departure and the line's scans on the way. `InTransit_CustomsReleased` is the export clearance and
  `InTransit_Departure` the arrival at the delivery point, both on the way. The line also files its record of the shipper's data and
  its expected delivery date under `InTransit_Other`; they move nothing and have no stage. Other nodes
  fall to the shared wording rules. The shipment's status gives the stage when it is further on:
  `Sented` (shipped), `Finished` (delivered) and `Failed` (exception).
- The reply does not name the line. The line's number names it when one carrier's high-confidence
  rule claims it.

## Numbers

A parcel the app tracked was numbered `AF` and 21 digits. 17TRACK reported it from Alphastline and
Alphastline's tracker answers it. AF reads as the initials of 傲飞. No public source shows a whole
number, so the rule offering Alphastline for that layout is low and recognition asks its tracker.
The synthetic sample is in [`numbers.json`](numbers.json).

## Links

Its tracker looks numbers up in place, so no address names one.

## Testing

`npm run test:carriers:live -- carriers/alphastline`, with `ALPHASTLINE_TRACKING_NUMBER` and
optionally `ALPHASTLINE_UNKNOWN_NUMBER` set outside the repository.
