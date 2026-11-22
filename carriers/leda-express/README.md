# Leda Express

Leda Express (乐达全球速递) of Flushing, New York, forwards parcels from the United States to
China: it takes them in at Hong Kong, clears them through customs in Shenzhen and hands them to SF
Express, which delivers them. The adapter reads the tracking page on Leda's site.

Lindao Express (`ldxpress.com`, carrier `lindao-express`) is a different company, a Shanghai
forwarder flying parcels to Japan. Some aggregators list both as "LD Express".

## How it works

`direct` posts `express=<number>` to `http://www.leda-express.com/queryexpress.html` as the site's
tracking form does, with no session, captcha or account. The site answers over HTTP only; its HTTPS
port does not answer. The page heads the results with Leda's waybill, which must be the whole number
asked, and the courier and waybill in China, then lists the rows oldest first. A request that fails
to reach the server gets one `retry` in the rest of the budget.

An unknown number is HTTP 200 too, with the notice `错误: Tracking#: <number> - Not Found`. Only
that notice naming the whole number asked is not found. A notice for another number, a page without
its results block or a row the parser cannot read is a schema failure; HTTP 401/403 or a bot check
is a challenge.

## Notes

- Leda's own rows, in traditional or simplified Chinese, open with their place in `【】`; SF
  Express's rows, copied word for word, open with their city in `[]`. The place becomes the
  location and the wording after it the description. SF's long-haul rows name no city of their own
  and get no location.
- The header names the courier in China and its waybill, which becomes `delivery_tracking_number`,
  with `delivery_carrier` set to `sf-express` when SF Express's rules offer that number.
- SF's rows name the courier on a delivery round with their phone, and a partner point with its
  phone and address. The adapter keeps them in the wording, as the SF Express adapter keeps SF's
  remarks, and takes the place only from the `[]` prefix.
- Times are to the minute on China's wall clock and stay `local_time`. The rows carry no codes, so
  the status map reads their wording.

## Numbers

Waybills are LD and fourteen digits. No detection rule claims the shape, so select Leda Express
explicitly. The sample and its source are in [`numbers.json`](numbers.json).

## Limitations

- No delivery estimate, weight or proof of delivery.
- Leda has only been seen handing parcels to SF Express. Another courier named in the header keeps
  its waybill as `delivery_tracking_number` without a `delivery_carrier`, and its rows may be left
  to the shared wording rules or unstaged.

## Testing

`LEDA_EXPRESS_TRACKING_NUMBER=… LEDA_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/leda-express`

Neighbouring numbers are often real waybills, so take an unknown number such as
`LD00000000000000` rather than a real one with a digit changed.
