# Bester Express

Bester Express (飛斯特運通, in English also Best International Transportation, BTR) is an express and freight firm
based in Taoyuan, with a company in Shenzhen. Kuaidi100 lists it twice, as `bester` and `exbtr`; both are this
firm and its one tracker. Tracked through the waybill page on exbtr.com.

## How it works

1. `direct`: one `POST https://www.exbtr.com/index.php?m=content&c=index&a=orderAjax` with the form the waybill
   page sends on opening: `trackingNo`, the page's member code `T00195`, an empty `code`, `siteid=1` and
   `status=2`, which skips the verification code. It needs no cookie or account. The reply is an HTML fragment of
   rows, oldest first, each with a clock to the minute, the office that wrote it and its text.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- The reply does not echo the number: the rows are those of the number in the request.
- The fragment's `nodata` block saying 抱歉，没有找到符合条件的信息 is the answer for a number the firm holds
  nothing under, which is not found. A whole page, which carries that block before its script asks for the rows,
  is a changed route or a browser check, never not found, and so is a non-200 reply.
- The catalog's tracking link opens the waybill page with the number in its address; the page asks for the rows
  itself.

## Notes

- Clocks have no zone and an English month, as `2017-JUL-31 11:07`. The firm's offices in Taiwan and China both
  keep UTC+8, so every row is dated on Taiwan's clock, with `carrier` as the basis.
- The transfer centre's rows name the waybill the parcel goes on with, as 转运单：EMS:…. That line is kept out of
  the row's text and stays in `original_description`. China Post is the delivery carrier, with that number, when
  the line names EMS or China Post and China Post's rules take the number; China is then the destination. A
  domestic EMS waybill of digits alone is not one China Post's rules take, so it names no delivery carrier.
- A first row from a branch in Taiwan, such as 桃園分公司, gives Taiwan as the origin.
- Phones and the names of who signed are taken out of a row's text.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- A parcel from China to Taiwan names no destination.

## Numbers

Waybills are SWE and nine digits, or eleven digits, on the samples. Both shapes are other carriers' too, so
detection does not offer Bester Express; the adapter answers explicit selection of any number of 6 to 30 letters
and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/bester` tracks the first public sample, or the number in
`BESTER_TRACKING_NUMBER`, and checks an invented number, or the one in `BESTER_UNKNOWN_NUMBER`, reads as not
found.
