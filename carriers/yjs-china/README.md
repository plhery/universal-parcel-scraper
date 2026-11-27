# YJS Express

YJS Express (益加盛快递, 益加盛物流, 赤峰益加盛物流有限公司) is a Chifeng express firm that carries parcels between
Hong Kong and mainland China. Its site is yjs-china.com. Tracked through the tracking page on that site.

## How it works

1. `direct`: one `POST http://www.yjs-china.com/Home/QueryOrder` with the form `WayBillNo={number}`, as the
   page's own form sends it. It needs no cookie, token, account or browser. The site answers plain HTTP only:
   its HTTPS certificate is self-signed for the server's own name. The reply is the HTML page, with the number
   as the value of its search field and the rows in `table.printTable`, newest first, each
   `<tr><td>clock</td><td></td><td>wording</td><td></td></tr>` under the 时间 / 地点和跟踪进度 header.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The page echoes the number only as its search field's value, so that value must be the whole number asked;
  a page for another number, or one with the field empty, is not an answer.
- The result table with its header and no row, for the number asked, is not found. It is the carrier's only
  not-found signal: the page prints no message for an unknown number.
- A page without the search field or the table is a changed page, ASP.NET's error page with HTTP 200 a
  transport failure, and a redirect or 404 a moved page.
- No tracking link: the page answers a form post only, over plain HTTP, so the catalog links neither it nor a
  search page.

## Notes

- Clocks are wall clocks to the second with no zone. The firm is in Chifeng and its rows are scans in China,
  the last of them a mainland courier's round, so each row is dated on China's clock with `carrier` as the
  basis and keeps its wall clock. A clock that would date a row after the lookup leaves it its wall clock
  alone.
- Rows have no code; `statuses.json` records each wording seen, and the status map reads the same rows at any
  branch or station by their pattern.
- Rows name the courier on the round (派件人) with their phone, the signer (签收人), and the phone to call the
  courier or the station. The adapter takes a role word and the name after it, a call line with its number,
  any other phone number with its label and a pickup code out of the wording. Branch and station names stay. A
  signature by the sender stays, since it names no one and reads as the return. A row left with nothing is
  dropped.
- Places stay in the wording: `location` comes back empty.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- Rows read like a mainland courier's last-mile scans relayed by the firm, but they name no other carrier or
  number, so no hand-off is read.

## Numbers

The public sample is `CHNYJS` and eight digits; detection names the firm for that shape. The adapter answers
explicit selection of any number of 6 to 30 letters and digits. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/yjs-china` tracks the public sample, or the number in
`YJS_CHINA_TRACKING_NUMBER`, and checks an invented number, or the one in `YJS_CHINA_UNKNOWN_NUMBER`, reads as
not found.
