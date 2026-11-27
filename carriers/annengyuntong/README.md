# Annengyuntong Logistics

Annengyuntong Logistics (安能运通物流, 深圳市安能运通物流有限公司) is a road freight firm in Shenzhen.
It is not ANE Logistics (安能物流, [`ane-logistics`](../ane-logistics/README.md)), a different firm with
its own tracker. Its waybills are on Lanqiao's TMS (蓝桥, lqfast.com); its site links the platform's
WeChat waybill portal under the firm's company id.

## How it works

1. `direct`: one `GET https://wx.lqfast.com/Pub/GET_TYD_DETAIL` with the firm's company id and the
   number, through the platform reader in [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts). Its
   README describes the request, the not-found answer and the checks.
2. `retry`: one more try when the request fails to reach the portal or hangs.

- The portal finds a waybill by its waybill number (运单号, digits) or its cargo number (货号), which
  is ANYT and the same digits. The record must carry the number asked as one or the other.

## Notes

- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- Rows drop the branch's enquiry phones (【查询电话：…】) and the signer the pickup row names
  (办理提货；签收人【…】). A row that starts with a city in brackets gives it as the location.
- A row on the road can name the expected arrival day and month (在途 预计2月6日到达). It stays in
  the wording; with no year it is not read as the expected delivery.
- The firm's wordings, and the platform templates its portal settings word, are in
  [`statuses.json`](statuses.json). The return receipt's rows leave the stage of the row before them.

## Limitations

- No weight or proof of delivery: the portal shows the piece count and the signed receipt, which
  are not read.

## Numbers

A cargo number of ANYT and eight to ten digits names the firm: the prefix is its initials, and no
other carrier's rule or sample has it. The bare waybill number is a digit run no rule claims, so it
needs explicit selection. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`ANNENGYUNTONG_TRACKING_NUMBER=… ANNENGYUNTONG_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/annengyuntong`
