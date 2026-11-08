# Kuayuan Express

Kuayuan Express (跨源速递), run by Shenzhen Kuayuan Express Supply Chain, ships online orders from China to
the United States, Europe and other countries, and hands some to China Post. Its site is
kuayuanexpress.com.cn. Tracked through the tracking form on its home page.

## How it works

1. `direct`: `POST https://kuayuanexpress.com.cn/api/re-toms/v1` with the JSON the home page's script
   sends: the method `getTrackInfoOutside`, the number in `param.codes`, `noUserCode: "1"`, a timestamp,
   the token the script gives every visitor and `lang: "en_US"`. It needs no cookie, CAPTCHA or browser,
   and the service does not check the token.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The reply lists one entry per number asked under `data.detail[""]`. A number the tracker knows is
  `ask: 1` with the shipment: Kuayuan's number (`shipper_hawbcode`), the line's number
  (`server_hawbcode`), the destination's country code and the scans, newest first, each a wall clock,
  a place, a wording and a code. The shipment must name the whole number asked.
- A number the tracker has nothing for is `ask: 0` with "Trajectory Information does not exist"
  (轨迹信息不存在). Only that answer is not found. Another `ask: 0` or a reply code other than 200 is
  inconclusive, a redirect or a 404 is a moved route, HTTP 403 or a browser check is a challenge, and
  a reply that is not the expected JSON is a schema failure.

## Notes

- The map stages scans by their code. Kuayuan writes the scans of the line it hands a parcel to under
  `ND`, in the line's own words. The shipment's status uses the same codes as its scans, and the home
  page names the final ones: `CC` delivered, `CF` failed to deliver, `UE` returned.
- Scans are wall clocks without a zone, on the clock of their place. Each keeps its `local_time` and
  place. Export scans can be written at whole hours after the first scan, to the same second, and
  can come before China Post's first scan. They are kept as Kuayuan writes them.
- The reply does not name the line. The line's number names it when one carrier's high-confidence
  rule claims it, such as China Post's `ZS` numbers.
- The recipient's name and town and the customer's reference are not kept.
- 17TRACK names the carrier "KUAYUAN SUPPLY CHAIN".

## Numbers

The example the home page prints and a parcel the app tracked share one layout: `3`, three letters,
the last digit of the year and the month and day the order was created, then a five-digit serial.
Kuayuan's tracker answered both. A low-confidence rule offers Kuayuan for that layout and recognition
asks its tracker. The adapter takes any digit, three letters and ten digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

Its tracker looks numbers up in place, so no address names one.

## Testing

`npm run test:carriers:live -- carriers/kuayuan-express`, with `KUAYUAN_EXPRESS_TRACKING_NUMBER` and
optionally `KUAYUAN_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
