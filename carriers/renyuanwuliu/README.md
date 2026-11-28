# Renyuan Logistics

Renyuan Logistics (任远物流, 深圳市任远物流有限公司) is a road freight firm in Shenzhen. Its waybills
are on Lanqiao's TMS (蓝桥, lqfast.com); its site links the platform's WeChat waybill portal under the
firm's company id.

## How it works

1. `direct`: one `GET https://wx.lqfast.com/Pub/GET_TYD_DETAIL` with the firm's company id and the
   number, through the platform reader in [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts). Its
   README describes the request, the not-found answer and the checks.
2. `retry`: one more try when the request fails to reach the portal or hangs.

- The record must carry the number asked as its waybill number (运单号) or cargo number (货号, the
  waybill number and the piece count), and name the firm as its carrier (`cygsname`) when it names one.

## Notes

- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- Rows drop the signer (签收人：…) and the truck's plate (车牌号【…】). A row that starts with a city
  in brackets gives it as the location.
- A waybill can carry two delivered rows: 货物已签收 at the delivery and 已签收 when the signature is
  recorded, weeks later on the example. The later one leads.
- The firm's wordings are in [`statuses.json`](statuses.json).

## Limitations

- No weight or proof of delivery: the portal shows the piece count and the signed receipt, which
  are not read.

## Numbers

The waybill numbers are bare runs of seven digits, which say nothing about the firm, so no rule
claims them and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`RENYUANWULIU_TRACKING_NUMBER=… RENYUANWULIU_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/renyuanwuliu`
