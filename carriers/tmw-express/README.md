# TMW Express

TMW Express (明达速递) sends parcels from Australia to China, by air through Perth Airport, as
standard parcels, milk powder lines and international lines, and hands them to a Chinese courier
that delivers. The adapter reads the order lookup behind the tracker on its website.

## How it works

1. `direct`: one `POST https://www.tmw-express.com.au/qt/order/searchAirStep` with the form field
   `docnewcode`, as the tracker's own script sends it. It needs no cookie, session, CAPTCHA or
   browser.
2. `retry`: the request once more when it fails to reach the service or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- The reply holds the steps TMW Express's staff enter (`airStepList`) and the rows of the Chinese
  courier (`logisticsrecordList`), which keep kuaidi100's fields. The adapter reads both into one
  history, newest first.
- Steps carry a number, which becomes `provider_code`; the status map reads the numbers the
  tracker's script names. The script names no wording for steps 0 and 2 and hides them, and so
  does the adapter.
- The courier's rows have no code. The shared wording rules classify them, and a row they do not
  know stays unstaged. Couriers' and signers' names and phone numbers are taken out of the
  wording.
- `该订单不存在` with no data is the only not-found answer. `未传递订单号` means the service read no
  number, so the request changed: a schema failure. Any other failure is indeterminate. A known
  order without a step or a row is no history (`listed`).
- The reply does not repeat the number. When it names one, it must be the number asked, or the
  answer is indeterminate.
- The label's QR code opens a page on `meian.expressgo.cn` or `shop.expressgo.cn` that calls the
  same lookup. It is TMW Express's own page, not a tracker for the Chinese leg, so its links route
  here.

## Notes

- Neither the steps nor the courier's rows state a zone, so the clocks stay `local_time`. The
  carrier's timezone is Australia/Perth, where its steps start. Perth and China both keep UTC+8
  without daylight saving, so consumers that date local clocks place both legs alike.
- The staff pick a step's time in a date picker, which sets midnight when they pick a day alone.
  A step at midnight keeps only its day.

## Numbers

The label prints the order number as a Code 128 barcode with no lower case. The adapter takes 6
to 40 letters and digits with at least one digit. No detection rule claims it, so select the
carrier explicitly. No public page shows an order number, and the fixtures are synthetic.

## Limitations

- No delivery estimate, weight, service, place, recipient or proof of delivery.
- The reply does not name the Chinese courier or its tracking number.

## Testing

`TMW_EXPRESS_TRACKING_NUMBER=… TMW_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/tmw-express`
