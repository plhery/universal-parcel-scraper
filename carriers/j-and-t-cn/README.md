# J&T Express China

J&T Express China's domestic network. Tracked through the lookup its tracking page makes, with
the last four digits of the recipient's or sender's phone the tracker asks for.

## How it works

1. `direct`: one
   `GET https://official.jtexpress.com.cn/official/waybill/trackingCustomerByWaybillNo/v_7` with
   `waybillList`, the phone digits in `phoneLast` and the captcha's `randstr` and `ticket` left
   empty, as the page sends them. The page signs each request: its `times` header is the time in
   milliseconds and `sign` is MD5 of MD5 of a constant the page ships and that time. It needs no
   cookie or browser. The JSON reply has one answer per waybill, which names it in `keyword` and
   lists its scans in `details`, newest first. An answer without scans carries a `code`, with
   which the page asks `v_5` for them; the adapter does the same.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- The digits come from the optional `phoneDigits` input, which the catalog offers for this
  carrier. Without four digits the adapter asks for them (`input_required`) before any request,
  so a lookup without them goes to universal providers.
- Code 1350200255 (`手机号不正确`) answers wrong digits and unknown waybills alike. It is
  `input_required` with the reason `phone_digits_mismatch`, and universal providers answer
  instead.
- An answer that leaves the waybill out is not found. A known waybill without scans in either
  stage has no history. Code 149000017 refuses the request's signature or parameters and is a
  schema failure. A 404 or a redirect is a moved route, and a page in place of JSON is a
  challenge.
- The answer's `keyword` must be the waybill asked.
- The digits and the second stage's `code` are credentials. They stay out of error messages and
  request diagnostics, and the digits never reach a universal provider.

## Notes

- A scan's description is its status, such as `运送中`, staged through `statuses.json`. A scan
  without one has its sentence without the people, phones and bracketed text it names.
- The sentences name couriers, signers and their phones; the reply also has delivery pictures
  and the courier's details. None of these is read, and scans have no location.
- Scan times are Beijing time, without an offset, and read as instants at `+08:00`.

## Limitations

- No ETA, weight or location.
- A lookup needs the phone digits; without them the history comes from universal providers.
- A history longer than 100 scans keeps the newest 100.

## Numbers

The tracker accepts thirteen digits, or `JT` or `UT` followed by thirteen digits, and puts `JT`
before thirteen bare digits. Archived lookups on J&T China's tracker carry `JT` numbers. J&T's
Philippine network prints the same `JT` and thirteen digits, so `j-and-t-cn-1` only suggests
J&T China alongside J&T Express. Bare thirteen-digit numbers are shared by many carriers and
have no rule.

## Links

The home page form sends up to ten numbers to `jtexpress.com.cn/service.html` in `indexIpt`,
so `www.jtexpress.com.cn/service.html?indexIpt={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-cn`, with `J_AND_T_CN_TRACKING_NUMBER` and
`J_AND_T_CN_PHONE_DIGITS` set outside the repository.
