# UBUYLOGI

UBUYLOGI (优拜物流) is a parcel forwarder founded in Germany: its warehouse there takes a customer's parcel and
sends it by air to China, where it clears customs and SF Express delivers it. Tracked through the tracking page on
ubuylogi.com.

## How it works

1. `direct`: one `GET https://www.ubuylogi.com/track/?num=<number>`, with no cookie or account. The reply is HTML:
   a heading that names the number over a table of rows, newest first, each a clock and a text.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- The heading, `运单号<number>的物流信息`, must name the number; a page of another number is refused.
- The table's header row alone under that heading is the answer for a number the firm holds nothing under, which
  is not found. The reply does not name the number elsewhere. A page without the heading or the header row is a
  browser check or a changed page, and a non-200 reply is a moved page.

## Notes

- Clocks have no zone and come to the second. The rows older than the first one that has the parcel in China, its
  arrival at a Chinese airport or SF Express's collection, are dated on Germany's clock with `carrier` as the
  basis; that row and the newer ones on China's, with `destination` as the basis. The airline's rows are typed by
  hand, so the order of the rows decides, not their clocks.
- The warehouse's first row names SF Express's waybill. It is the delivery tracking number when SF Express's own
  rules take it.
- SF Express's rows can name the courier with their mobile, or the delivering outlet's street. The adapter removes
  them from the text.

## Limitations

- No delivery estimate, weight, sender or recipient. Places appear only in SF Express's texts.

## Numbers

Waybills are twelve digits on the sample. That bare digit run is shared with many carriers, so detection does not
offer UBUYLOGI; the adapter answers explicit selection of any number of 6 to 30 letters and digits. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/ubuy` tracks the public sample, or the number in `UBUY_TRACKING_NUMBER`,
and checks an invented number, or the one in `UBUY_UNKNOWN_NUMBER`, reads as not found.
