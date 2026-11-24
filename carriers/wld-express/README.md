# WLD Express

WLD Express (万立德), run by Shenzhen Wanlide International Logistics and Guangzhou Wanlide Supply Chain,
ships cash-on-delivery parcels from China to Europe, Japan and Southeast Asia. Its site is wld-express.com.
Tracked through the track query of its order system on wld-exp.com.

## How it works

1. `direct`: `POST https://wld-exp.com/api/re-toms/v1` with the JSON the track query page's script
   sends for a guest: the method `getTrackInfoOutside`, the number in `param.codes`, `noUserCode: "1"`,
   a timestamp, the token the script signs it with and `lang: "en_US"`. The token is part of the MD5 of
   the method, the timestamp and a key the script gives every visitor. It needs no cookie, CAPTCHA or
   browser.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply lists one entry per number asked under `data.detail[""]`. A number the tracker knows is
  `ask: 1` with the shipment: WLD's number (`shipper_hawbcode`), the line's number
  (`server_hawbcode`), the destination's country code and the scans, newest first, each a wall clock,
  a place, a wording and a code. The shipment must name the whole number asked.
- A number the tracker does not hold is `ask: 0` with "Code does not exist" (单号不存在), naming the
  number. Only that answer is not found. Another `ask: 0` or a reply code other than 200 is
  inconclusive, a redirect or a 404 is a moved route, HTTP 403 or a browser check is a challenge, and
  a reply that is not the expected JSON is a schema failure.

## Notes

- Kuayuan Express runs the same order system, with another not-found wording
  ([its adapter](../kuayuan-express/README.md)).
- WLD writes its own first scan under `IR` and relays the line's scans under `ND`, `DD` and `TT`, in
  the line's words. `ND` covers delivery attempts as well as transit, so the map stages those scans by
  their wording. The page names the shipment statuses: `AF` in the network, `CC` delivered, `CF`
  failed to deliver, `UE` returned.
- Scans are wall clocks without a zone, on the clock of their place: China for WLD's own, the
  destination for the line's. Each keeps its `local_time`. A line's place is written `office|town`
  and is kept as `office, town`.
- The line's number becomes `delivery_tracking_number`; the page shows it as the tracking number. The
  reply does not name the line, so `delivery_carrier` is set only when one carrier's high-confidence
  rule claims that number.
- The reply also carries the recipient's name and town, which the page does not show, and the
  customer's reference. None of them is kept. Child parcels of a multi-piece shipment are not read.

## Numbers

ParcelPanel's sample is WLD, two letters, the last digit of the year and the month and day the order
was created, then a five-digit serial. The adapter takes WLD, two letters and ten digits. No rule
offers WLD Express yet. The sample and its source are in [`numbers.json`](numbers.json).

## Links

Its track query looks numbers up in place, so no address names one.

## Testing

`npm run test:carriers:live -- carriers/wld-express` looks up the public sample, or
`WLD_EXPRESS_TRACKING_NUMBER` when set, and an invented number, or `WLD_EXPRESS_UNKNOWN_NUMBER`.
