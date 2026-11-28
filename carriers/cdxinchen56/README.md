# Xinchen Logistics

Xinchen Logistics (鑫宸物流, 成都鑫宸物流有限公司) is a road freight firm in Chengdu. Its waybills
are on Lanqiao's TMS (蓝桥, lqfast.com); its site's 货物查询 link opens the platform's query page
under the firm's company id.

## How it works

1. `direct`: one `GET https://wx.lqfast.com/Pub/GET_TYD_DETAIL` with the firm's company id and the
   number, through the platform reader in [`../anjiexin56/lqfast.ts`](../anjiexin56/lqfast.ts). Its
   README describes the request, the not-found answer and the checks.
2. `retry`: one more try when the request fails to reach the portal or hangs.

- The portal answers only for the company id it is asked under, and the record it returns names the
  firm as carrier (`cygsname`). The record's waybill number (`unit`) or cargo number (`billno`) must be
  the number asked.

## Notes

- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- The signature rows name the signer between 由 and 签收 (已经由…签收, 货物已由…提货签收); the
  reader leaves the name out.
- The rows name branches and cities in their wording, without the brackets the platform reader takes
  a location from, so events carry no location.
- The firm's wordings are in [`statuses.json`](statuses.json).

## Limitations

- No location, weight or expected delivery.
- The portal reads the number as an integer: a number past its range comes back as the firm's
  waybill 0, which the reader refuses as not the parcel asked.

## Numbers

The waybill number is a bare counter of seven digits, a shape many carriers share, so there is no
detection rule: a lookup asks Xinchen only when the user picks it. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`CDXINCHEN56_TRACKING_NUMBER=… CDXINCHEN56_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/cdxinchen56`
