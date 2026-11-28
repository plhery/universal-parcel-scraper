# Kaiqitong Logistics

Kaiqitong Logistics (凯骐通物流, 深圳市凯骐通物流有限公司) is a road freight firm in Shenzhen. Its
waybills are on Lanqiao's TMS (蓝桥, lqfast.com); its site links the platform's waybill query page
under the firm's company id.

## How it works

1. `direct`: one `GET https://wx.lqfast.com/Pub/GET_TYD_DETAIL` with the firm's company id and the
   number, through the platform reader in [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts). Its
   README describes the request, the not-found answer and the checks.
2. `retry`: one more try when the request fails to reach the portal or hangs.

- The record must carry the number asked as its waybill number (运单号) or cargo number (货号), and
  name the firm as its carrier (`cygsname`) when it names one.

## Notes

- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- The firm writes most rows itself, with the city after a colon (到达：玉溪市，预约派送); only the
  platform's depot rows start with a city in brackets, which becomes the location.
- 预约派送 is the destination branch booking the delivery with the consignee, so the row stays in
  transit rather than out for delivery.
- The firm's wordings are in [`statuses.json`](statuses.json).

## Limitations

- No weight or proof of delivery: the portal shows the piece count and the signed receipt, which
  are not read.

## Numbers

The waybill numbers are bare runs of seven digits, which say nothing about the firm, so no rule
claims them and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`KQTWL_TRACKING_NUMBER=… KQTWL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/kqtwl`
