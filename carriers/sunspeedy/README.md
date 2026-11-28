# Sunspeedy

Sunspeedy (新速航, 香港新速航) is a Hong Kong forwarder that clears parcels into mainland China and carries them
between Hong Kong and China. Its site is sunspeedy.hk. Tracked through the site's waybill search, behind a
four-digit verify code.

## How it works

1. `direct`: one `GET https://www.sunspeedy.hk/delivery.php/web/Auth`, the verify code picture, which opens the
   CodeIgniter `ci_session` the code is kept in. The shared text model reads it, and one `POST` of `delivery_id`,
   `delivery_captcha` and `submit=提交` to `/delivery.php/web/info` returns the result page, UTF-8. The site's own
   form first posts the number to `/delivery.php/web/query`, but the picture opens the session as well, so the
   adapter skips that page.

- A refused code gives the form again with 驗證碼輸入有誤 in its message line. The adapter then takes a new
  picture in a new session, three pictures in all within the lookup's budget, and skips a reading that is not four
  digits without sending it. When none is accepted the lookup fails as a challenge whose message counts the refused
  and unread pictures.
- The result page names the number in a line, 運單號:…結果, and keeps it in the form's input; both must be the
  number asked. 沒有找到相關記錄 in the message line is the tracker's answer for a waybill it does not know, which is
  not found. That page names the number only in the form's input, which must be the number asked. A page with
  neither answer is a changed page.

## Notes

- The model read 21 of 22 pictures labelled by eye, and each of the ten codes it read during live lookups was
  accepted. The pictures are 90 by 30 PNGs of four coloured digits crossed by red lines; the worker's `sunspeedy`
  profile reads them as they come, which read best of the settings tried, better than erasing the red lines.
- Rows are a minute on a clock with no zone and a text in brackets, which the adapter drops. The firm writes places
  into the text in Latin letters. A row whose places all lie in one country that keeps one clock, by the country's
  name or by a town the firm's rows have named (Legionowo and Warszawa, in Poland), is dated on that country's
  clock with `place` as the basis, and the first place is its location. Any other row, or one dated after the
  lookup, keeps its wall clock alone: the firm's warehouses are in Hong Kong and China, and rows without a place do
  not say which.

## Limitations

- No delivery estimate, weight, service name, destination, sender or recipient.
- The search only answers a form post with a session's code, so the catalog gives no tracking link.

## Numbers

The public sample is two letters, twelve digits and CN, the shape of a post's numbers, so detection does not offer
Sunspeedy, and the adapter answers explicit selection of any number of 8 to 30 letters and digits. The sample and
its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/sunspeedy` tracks the public sample, or the number in
`SUNSPEEDY_TRACKING_NUMBER`, and checks an invented number, or the one in `SUNSPEEDY_UNKNOWN_NUMBER`, reads as not
found.
