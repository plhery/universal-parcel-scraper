# Woori Taekbae

Woori Taekbae (우리택배), also known as 호남택배 and run by Honam Logis (호남로지스), delivers
parcels across South Korea. Tracked through the lookup its tracking page on honamlogis.co.kr
makes.

## How it works

1. `direct`: one `POST http://www.honamlogis.co.kr/tracking_number.php` with the form field
   `SLIP_BARCD`, as the page's script sends it. No cookie, token or browser is needed. The reply
   is JSON served as `text/html`.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- The host's HTTPS certificate is invalid, and the page itself is served and posts over plain
  HTTP, so the adapter reads the lookup over HTTP through the shared transport. Certificate
  checks are never turned off.
- Only a shipment whose `SLIP_BARCD` is the number asked is read; a reply for another number,
  or one that names several shipments, is indeterminate.
- A number the tracker does not know gets HTTP 200 and `{"MSG_ID":"0000","ODS0_TOTAL":0,"ODS0":[]}`,
  which does not repeat the number. Only that reply is not found. Another `MSG_ID` is
  indeterminate; a redirect or a missing route is a moved lookup; a bot check is a challenge; any
  other reply, an empty or HTML one included, is a schema failure.
- A shipment listed with no scan is no history, with the reason `listed`.

## Notes

- The reply carries the sender's and recipient's names, phone numbers and address unmasked;
  the page masks them in the browser. The adapter never reads them, nor the branches' phone
  numbers, the goods, the price or the scan's user.
- The place is the scan's branch or terminal (`SCAN_AGY_NM`), without phone numbers, and dropped
  when it holds a masked name or a driver. The page shows the scan's user (`SCAN_USER_NM`) as
  the place instead, which can be a shipper or a member of staff.
- Scans give `yyyyMMddHHmmss` on Seoul's wall clock without an offset, so each keeps it in
  `local_time` and the catalog's Seoul clock dates it. A clock that does not read stays as text
  in `provider_time_text`.
- The reply lists scans oldest first. The adapter reverses them and sorts them stably by clock,
  newest first, so scans of one second keep their order.
- [`status.ts`](status.ts) stages a scan by its step name (`SCANGB_NM`), as the page does, and
  keeps the code (`SCANGB`) as `provider_code`. It also holds the step names the page's script
  words as sentences, which replies have not shown. No return has been seen: a step the map
  does not know has no stage, and after a delivery it leaves the parcel's stage open.

## Limitations

- No delivery estimate, weight, service or proof of delivery.
- The tracker drops an older shipment's scans and keeps listing it without them.
- The site's second form, for older waybills, posts to `/tracking_number2.php`. The adapter does
  not ask it.

## Numbers

Waybills seen are ten digits starting with 50, and the page accepts ten to fourteen digits.
Ten digits starting with 50 is a shape DHL Express and other carriers' rules take, so there is no
detection rule: the carrier is chosen by hand. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The catalog gives no tracking link or search page: the site's HTTPS certificate is invalid, so
an HTTPS link would open a certificate warning, and the catalog links only HTTPS pages.

## Testing

`WOORI_TAEKBAE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/woori-taekbae`, with
`WOORI_TAEKBAE_UNKNOWN_NUMBER` optionally set to a number the tracker does not know.
