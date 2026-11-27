# HP Express

HP Express (海派国际速递, HP Trust on its logo, hpexpress.com.au), based in Melbourne, flies parcels from Australia
to Xiamen, clears them through customs at Quanzhou and hands them to China Post. Tracked through the service its
tracking page asks.

## How it works

1. `direct`: one `GET https://www.hpexpress.com.au/rpc/comm/ex/order/logisticsInfo?orderSn={number}&_T={ms}`,
   as the page `/express/trackingInfo?orderSns={number}` sends it, `_T` being the moment of the request. It needs
   no cookie, token or account; the page's `target-platform: pc` header goes with it. `/rpc/order/logisticsInfo`,
   without `comm/ex`, is the signed-in customer's route and refuses a guest.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget.

- The reply echoes the number as `domesticTrackingNumber`. An `errorMsg` saying 未查到此快递单号 followed by
  that number is the service's answer for an order it does not know, which is not found. Another message, a
  `code` other than 1000 or an empty list is inconclusive, and a list without the order asked is refused. HTML is
  a browser check or a changed route, and a non-200 reply is a moved route or a request the service refuses.

## Notes

- The order has three legs, `internationalTrackingInfo` (Australia to the flight), `clearanceTrackingInfo`
  (Xiamen airport and customs at Quanzhou) and `domesticTrackingInfo` (China Post's scans), each newest first.
  They are merged into one history by `time`, which is epoch milliseconds, so every row is an instant.
- The text names the warehouse, airport or post office in brackets, such as 【中国厦门机场】; the first bracket
  is kept as the location. `statuses.json` records each text with its places as 【…】.
- The clearance row that releases the parcel names the courier in China and its number, 转入泉州邮政快递，
  包裹单号为：…. They become the delivery carrier and the delivery tracking number when the row names one courier
  and that courier's rules offer the number. China Post's domestic thirteen-digit numbers are outside
  [`china-post`](../china-post/README.md), so the public samples hand off nothing and keep the number in the text.
- China Post's rows name the postman and phones, and the delivery row who or where took the parcel in; those are
  taken out. The first row asks for the recipient's ID card with an upload link, which goes too.

## Limitations

- No public sample shows a parcel to Australia, or a hand-off to a courier other than China Post.
- The page also takes several orders at a time; the adapter asks one.
- No delivery estimate, weight, service name, sender or recipient.

## Numbers

HP Express's orders seen so far are HP and nine digits, a shape GLS Italy's rule also takes, so detection does not
name HP Express, and the adapter answers explicit selection for any number of 6 to 30 letters and digits. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.hpexpress.com.au/express/trackingInfo?orderSns={number}` opens the order on the tracking page. The search
page is the home page, with its tracking box.

## Testing

`npm run test:carriers:live -- carriers/hpexpress` tracks the public sample, or the number in
`HPEXPRESS_TRACKING_NUMBER`, and checks an invented order, or the one in `HPEXPRESS_UNKNOWN_NUMBER`, reads as not
found.
