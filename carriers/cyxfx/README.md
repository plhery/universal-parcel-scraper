# C&Y Global Logistics

C&Y Global Logistics (小飞侠速递, cyxfx.com) takes parcels in at its warehouses in Aurora, Illinois, flies them
to China, clears them through Chinese customs and hands them to a courier in China. Tracked through the service
its tracking page asks.

## How it works

1. `direct`: one `POST http://api.2019.cyxfx.cn/api/track/list` with the JSON `{"sns":"{number}"}`, as the
   tracking page on www.cyxfx.com sends it. The service answers plain HTTP only. It needs no cookie, token or
   account. The reply lists each waybill asked, as `sn`, with its rows.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest. The server is sometimes slow to accept a connection from abroad, so the
   default budget is 20 seconds.

- `ErrorCode` -1 with the message 错误的单号 and no data is the service's answer for a number it does not know,
  which is not found. Another error, or an empty list, is inconclusive, and a list without the waybill asked is
  refused. HTML is a browser check or a changed route, and a non-200 reply is a moved route or a request the
  service refuses.
- The service answers plain HTTP, so the catalog gives no search page or tracking link.

## Notes

- `Adddate` is a wall clock with no zone. The rows until the flight lands in China are dated on Aurora's clock,
  the firm's, with `carrier` as the basis. From the flight's arrival on, the rows are dated on China's clock with
  `destination` as the basis: the customs and hand-off rows follow the arrival by hours on China's clock and
  would come before it on Aurora's. A clock that would date a row after the lookup keeps its wall clock alone.
- `Status` is kept as the scan's code. [`status.ts`](status.ts) stages each row by its code and its text, the
  hand-off number replaced; other wording goes through the shared rules.
- The hand-off row names the courier in China and its number, 快递公司:顺丰速运,单号:…. They become the delivery
  carrier and the delivery tracking number when the row names one courier and that courier's rules offer the
  number.
- `Thrd_trace` on the hand-off row is that courier's raw route. It is read only when it is SF Express's route for
  the number the row hands over, and its scans are staged by SF's operation codes. Any other trace is not plainly
  the same parcel, and the hand-off row stands alone.
- `addr` (the recipient's address) and `Op_userid` are never read. The customs row names the clearing agent with
  a mobile; that clause, and any courier, signer or phone a row names, is taken out.

## Limitations

- No public sample shows a parcel from China to the US, or a hand-off to a courier other than SF Express.
- The page also takes up to ten numbers at a time; the adapter asks one waybill.
- No delivery estimate, weight, service name, sender or recipient.

## Numbers

C&Y's waybills seen so far are ten digits starting with 70, a run other carriers' numbers share, so detection does
not name C&Y, and the adapter answers explicit selection for any number of 8 to 30 letters and digits. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/cyxfx` tracks the public sample, or the number in `CYXFX_TRACKING_NUMBER`,
and checks an invented waybill, or the one in `CYXFX_UNKNOWN_NUMBER`, reads as not found.
