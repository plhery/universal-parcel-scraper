# ANJIEXIN Logistics

ANJIEXIN Logistics (安捷信物流, 深圳市安捷信物流有限公司) carries road freight (公路快运) from
Shenzhen to hubs across China. Its waybills are on Lanqiao's TMS (蓝桥, lqfast.com), whose WeChat
waybill portal at `wx.lqfast.com` its query page at `https://www.anjiexin56.com/cha` frames.

## How it works

1. `direct`: `GET https://wx.lqfast.com/Pub/GET_TYD_DETAIL` with the firm's encrypted company id
   (`companyid`), the number (`unit`) and the four other fields the waybill page sends, all empty. No
   cookie, session, CAPTCHA or phone digits: the firm's portal settings ask for none. The JSON is
   `{Sus, Data, Msg, Data2, …}`, with the rows in `Data` and the waybill's record in `Data2`, both as
   JSON strings.
2. `retry`: one more try when the request fails to reach the portal or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- `Sus` false with `Msg` 未找到运单！ is the portal's answer for a number the firm holds no waybill
  under, which is not found. Another refusal is inconclusive: 解码失败 is the portal failing to read
  the company id. A redirect or a 404 is a moved route.
- The record's waybill number (`unit`) or cargo number (`billno`) must be the number asked. The
  portal finds a waybill by either.
- The request, checks and rows are the platform's, in [`lqfast.ts`](lqfast.ts), with the tenant's
  company id and wordings as parameters, so another firm on it needs only its adapter and status
  map. The portal's `POST /NewAPI/DoWork` (`Business.BZB.GET_TYD_DETAIL`) gives the same reply
  wrapped in another envelope.

## Notes

- The rows give no zone. The firm and its hubs work in China, so each row keeps its wall clock in
  `local_time` and is dated on China's clock, with `carrier` as the basis. A clock that would date a
  row after the read keeps its wall clock alone.
- A row that starts with a place in brackets, as the platform's templates put the depot, gives it as
  the location: `【深圳】开单入库`.
- The record also holds the shipper's and consignee's names, phones and addresses, and `Data3` the
  branches' contacts; none of it is read. Rows drop an enquiry phone block, whoever signed, a driver
  and a truck's plate, and the wording stops before any other phone number.
- The record's `state` lags the rows (it still read 已分流 for a waybill signed for), so the stage
  comes from the rows.
- The firm's own wordings, and the platform templates its portal settings word, are in
  [`statuses.json`](statuses.json). The return receipt's rows (签收回单, 寄出回单, 收到回单, 返厂回单)
  are paperwork and leave the stage of the row before them.

## Limitations

- No delivery estimate, weight or proof of delivery: the portal shows the piece count and the
  signed receipt, which are not read.

## Numbers

The samples are bare runs of seven digits, which say nothing about the firm, so no rule claims them
and the adapter answers explicit selection. They and their sources are in
[`numbers.json`](numbers.json).

## Testing

`ANJIEXIN56_TRACKING_NUMBER=… ANJIEXIN56_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/anjiexin56`
