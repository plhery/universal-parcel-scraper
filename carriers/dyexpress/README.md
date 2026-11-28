# Dayi Express

Dayi Express (大億國際快遞, 深圳大亿快递), based in Bao'an, Shenzhen, carries parcels from China to Taiwan, Hong
Kong, Macau, Singapore and India. Tracked through the query page on dy-express.com.

## How it works

1. `direct`: one `POST https://www.dy-express.com/query/serchi` with the form's one field, `keyword`, holding the
   number. It needs no cookie, token or account. The reply is the query page, HTML, with a record for the number:
   a table of basic information and a table of rows, newest first, each with a clock to the second, a place and a
   text.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- The record names the number in its headings, as `编号<number> 跟踪状态`; a record for another number is refused.
- The notice 未找到任何快递信息 with the number in the search box, and no record, is the answer for a number the
  firm holds nothing under, which is not found. A page with neither a record nor the notice, or without the search
  box, is a browser check or a changed page, and a non-200 reply is a moved page.
- The form takes the number only in its body, so the catalog gives no tracking link.

## Notes

- Clocks have no zone. The place column names a station, often after the partner that runs it, as 博宇-台北 for
  the Taiwan partner's Taipei station. A row is dated on the clock of the city its station names, with `place` as
  the basis. A row whose place names no city the firm serves keeps its wall clock alone.
- The origin and destination come from the basic information's 始发站 and 目的地址, as 深圳出口 and 台北.
- The signed-for block's signer is not read, and phones and signers are taken out of a row's text. The service and
  the piece count are not kept.

## Limitations

- No delivery estimate, weight, sender or recipient.
- The form takes several numbers, one per line; the adapter asks for one.

## Numbers

Waybills are ten digits on the sample, a bare digit run many carriers share, so detection does not offer Dayi
Express; the adapter answers explicit selection of any number of 6 to 30 letters and digits. The sample and its
source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/dyexpress` tracks the public sample, or the number in
`DYEXPRESS_TRACKING_NUMBER`, and checks an invented number, or the one in `DYEXPRESS_UNKNOWN_NUMBER`, reads as not
found.
