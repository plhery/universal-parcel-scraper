# HD Express

HD Express (汇达物流, also HD Cargo), based in Vancouver with branches in Calgary, Edmonton, Montreal and
Toronto, ships parcels from Canada to China, where ZTO delivers them after customs. Its site is
hdc-express.com. Tracked through the service behind the guest tracking box on the site's sign-in page.

## How it works

1. `direct`: one `GET http://www.hdc-express.com/listBilLogistics?waybillNo={number}`. It needs no cookie,
   token, account or browser, and answers plain HTTP only. The reply is JSON: `code` 0 and the waybill's rows
   in `data`, each with its clock, wording, `state` step, waybill and the courier number the page shows.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- `code` 0, `msg` 成功 and no row is the answer for a number the service holds nothing under, which is not
  found. Another code, or no row with another message, is inconclusive; HTML is a browser check or a changed
  route, and a non-200 reply is a moved route.
- Only rows whose `waybillNo` is the whole number asked are read; a reply with none is not an answer.
- The site's tracking box opens `/dist/views/bil/logisticsList.html?waybillNo={number}` in a pop-up over the
  sign-in page, over plain HTTP, so the catalog links neither.

## Notes

- `updateTime` is a wall clock with no zone. The rows up to the parcel's departure for China (运单创建成功,
  分店已收件, 快件中心已揽收) are dated on Vancouver's clock, the head office's, with `carrier` as the basis.
  From the departure row on (快件已发往国内, step 4 of `state`, then customs and clearance) they are dated on
  China's clock, where the parcel is cleared and delivered, with `destination` as the basis. A zone that would
  date a row after the lookup leaves it its wall clock alone.
- `state` counts the steps and is kept as the scan's code; `statuses.json` maps each step and wording seen.
- The customs row names ZTO's waybill in brackets. That number becomes the delivery tracking number with ZTO as
  the delivery carrier when ZTO's own number shapes take it, and the row keeps its wording without it. The
  courier number the page shows (`expressNo`) names no courier, and can differ from ZTO's, so it is not read.
- A reply with the departure row gives China as the destination.
- Rows have no place: `location` comes back empty.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.
- A branch outside Vancouver keeps another clock, which the reply does not name.

## Numbers

Waybills are HDC and eleven digits, the day the waybill was created and a sequence. No other carrier's rule or
sample takes that shape, so detection names HD Express for it. The adapter answers explicit selection of any
waybill of letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hd-express` tracks the public sample, or the waybill in
`HD_EXPRESS_TRACKING_NUMBER`, and checks an invented waybill, or the one in `HD_EXPRESS_UNKNOWN_NUMBER`, reads
as not found.
