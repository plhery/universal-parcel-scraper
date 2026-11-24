# XingYunYi

XingYunYi (行运易物流, XYY) is a Guangzhou forwarder backed by Cainiao, running small-parcel and
express lines from China to North America, Europe, Oceania and elsewhere. Its site is
xingyunyi.com. Tracked through the service its tracking page asks.

## How it works

1. `direct`: `POST https://customerservice.xingyunyi.cn/api/Order/GetTracking` with
   `{"Numbers": [number]}` and the token the page's script sends as `Authorization: token …`. Every
   visitor gets the same token. It needs no cookie, CAPTCHA or browser.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply lists one shipment per number asked, under `InputTrackingNumber`. A number XingYunYi holds
  an order for comes with the order's id, XingYunYi's number (`SystemNo`), which must be the whole
  number asked, the line's number, the countries, the page's status for the shipment and the scans.
- A number it holds no order for comes back as an empty order with the id 0, no scan, no XingYunYi
  number and the default order time 0001-01-01, which the page shows as in transit without tracking
  information. Every invented number gets that order, and an order XingYunYi holds keeps its id with
  or without scans, so the empty order is not found.
- An order without a scan is no history with the reason `listed`, unless the page's status for it
  says more than Transit, such as Delivered: that status is then the answer, as a summary.
- A reply code other than 200 is inconclusive, a redirect or a 404 is a moved route, HTTP 403 or a
  browser check is a challenge, and a reply that is not the expected JSON is a schema failure. The
  service refuses a request with another token with a bare 403.

## Notes

- Each row starts with its place, then a comma and the wording. The place becomes the location, the
  wording the description and the whole row `original_description`. Places are towns in China and
  country codes abroad.
- Scans are wall clocks without a zone, on the clock of their place: China for XingYunYi's own, the
  destination for the line's. Each keeps its `local_time`.
- When the line's tracker no longer finds the line's number, the reply adds a "Not Found" row dated
  when the page asks. It is not a scan and is dropped.
- The scan codes are not shown on the page and one code covers transit and customs scans, so the
  wording stages a scan. The page's status Delivered decides the stage when the last scan's wording
  does not.
- The line's number becomes `delivery_tracking_number`; the page shows it beside the number. The reply
  does not name the line, so `delivery_carrier` is set only when one carrier's high-confidence rule
  claims that number.
- The days a delivered parcel took and the sender's country are shown on the page and not kept. The
  order's own status, which reads cancelled (已取消) for every order seen, is not shown and not read.

## Numbers

ParcelPanel's samples are XYYEX, ten digits and YQ. The tracker needs the whole number: without the
last two letters it answers with an empty order. The adapter takes XYY, two letters, ten digits and two
letters. No rule offers XingYunYi yet. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page opens the number from its `nums` parameter.

## Testing

`npm run test:carriers:live -- carriers/xingyunyi` looks up the first public sample, or
`XINGYUNYI_TRACKING_NUMBER` when set, and an invented number, or `XINGYUNYI_UNKNOWN_NUMBER`.
