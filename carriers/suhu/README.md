# Suhu Express

Suhu Express (速虎速运, SUHU Supply Chain) is a Chinese forwarder that flies cross-border
e-commerce parcels to Europe and hands them to a line in the destination country. Its site is
suhusupplychain.com. Tracked through the waybill form on its home page.

## How it works

1. `direct`: `GET https://www.suhusupplychain.com/` for the nonce in the tracking form's inline
   settings (`suhuLogistics`), then `POST /wp-admin/admin-ajax.php` with the action
   `suhu_get_tracking_info`, the number, `language=en` and that nonce, as the form does. It needs
   no cookie, key, CAPTCHA or browser. The nonce is read fresh for every lookup.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the
   budget.

- The reply is JSON with one order per number asked: Suhu's order number, its line's number,
  the destination's country code, and the scans, newest first, each a wall clock, a place, an
  English wording and a four-digit code. The order must name the whole number asked, as its
  order number or its line's.
- An unknown number is `success: false` with "错误信息：未查询到相应订单" (no matching order).
  Only that answer is not found. WordPress answers a nonce it does not accept with HTTP 403 and
  `-1`, which is inconclusive; a redirect or a 404 is a moved route, a browser check is a
  challenge, and any other reply that is not the expected JSON is a schema failure.
- The form's results page shows the same reply after a redirect; the adapter does not open it.

## Notes

- The map stages scans by their code. The first digit is the leg: 1 in China, 2 the export and
  the flight, 3 the destination's last mile.
- Scans are wall clocks on the clock of their place: the China scans read as Beijing time, and a
  flight from China lands in Amsterdam about twelve hours after it leaves only if the `AMS` scans
  are Amsterdam time. Each scan keeps its `local_time` and place.
- The reply does not name the line. Its number names it when one carrier's high-confidence
  rule claims it, such as J&T Express Germany's `JTDE` numbers.
- Proof-of-delivery links (`podUrls`) are not kept.
- 17TRACK names the carrier "suhu supply chain".

## Numbers

A parcel the app tracked was numbered three letters, thirteen digits and two letters. 17TRACK
reported it from suhu supply chain and Suhu's tracker answered it. With that one parcel and no
public number, no detection rule offers Suhu; recognition asks its tracker about numbers of that
layout. The adapter takes any number of eight or more letters and digits: other numbers reach it
when they are filed under Suhu.

## Testing

`npm run test:carriers:live -- carriers/suhu`, with `SUHU_TRACKING_NUMBER` and optionally
`SUHU_UNKNOWN_NUMBER` set outside the repository.
