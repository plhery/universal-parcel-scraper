# Longteng

Longteng (龙腾转运, longtengus.com) is a forwarder in Portland, Oregon that flies parcels to China,
clears them through Chinese customs and hands them to a courier in China. Tracked through the
TrackingInfo page of its site, the platform GOOD Express also runs on.

## How it works

1. `direct`: one `GET https://www.longtengus.com/TrackingInfo?TrackginNO={number}`, the
   parameter spelled so. The site links the page over plain HTTP; HTTPS serves the same page, so
   the number never travels in the clear. The page renders the rows on the server: no cookie,
   form state, CAPTCHA or browser is needed.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the
   budget.

Recognition asks the same page.

- Only the waybill whose number is the whole number asked is read; a page for another number is
  indeterminate.
- A number the tracker does not know gets HTTP 200 and one row, "暂无查询结果", stamped with the
  moment of the lookup. Only that answer is not found. A redirect or an error status is a moved
  route, a bot check is a challenge, and any other page is a schema failure.
- [`trackingInfo.ts`](../good-express-us/trackingInfo.ts) in GOOD Express's folder reads the
  waybill and its rows for both sites; each keeps its own wording, clock and hand-off.

## Notes

- Every row is dated on US Pacific time, the rows in China too. The not-found row carries the
  moment of the lookup on Pacific time, and the arrival at the port of entry is stamped to the
  second like the Portland rows. Read on China time, the clearance rows would come before that
  arrival. A row the zone would date after the lookup keeps only its wall clock.
- The rows name no place apart from Portland inside the wording, so no location is read.
- The hand-off row ends with the courier's number in China. It becomes the delivery tracking
  number, with the delivery carrier, only when the row also names the courier and that courier's
  rules offer the number. The public sample's row gives the number alone, so nothing is handed
  off.
- [`status.ts`](status.ts) stages Longteng's rows by their whole wording, the hand-off number
  replaced; other wording goes through the shared rules.

## Limitations

- No public sample shows a delivery or the courier's own rows.
- The page also takes up to ten numbers at a time; the adapter asks one waybill.
- No delivery estimate, weight, service or destination.

## Numbers

Longteng's waybills seen so far are S and thirteen digits, a date and a serial. One sample is too
few to claim the shape, so detection does not offer Longteng. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

`www.longtengus.com/TrackingInfo?TrackginNO={number}` opens one waybill on the tracker. The
search page is the home page, with its tracking box.

## Testing

`npm run test:carriers:live -- carriers/longtengus`, with `LONGTENG_TRACKING_NUMBER` and
`LONGTENG_UNKNOWN_NUMBER` optionally set outside the repository.
