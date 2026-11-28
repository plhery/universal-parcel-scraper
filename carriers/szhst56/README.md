# Hongshuntong Logistics

Hongshuntong Logistics (鸿顺通物流, 深圳市鸿顺通物流服务有限公司) is a road freight firm based in
Shiyan, Shenzhen. Its site's tracking page renders a waybill's rows on the server.

## How it works

1. `direct`: one `GET https://www.szhst56.com/tracking.php?s=<number>`, the request the site's form
   sends, with no cookie or session.
2. `retry`: one more try when the request fails to reach the site or hangs.

- The page heads each number with 单号…跟踪扫描记录 over its rows, newest first, or with
  单号…无效或暂无追踪记录. for a number it holds no record under, which is not found. The heading must
  name the number asked; a page without the block is a changed page, or a challenge when it is a
  bot check.

## Notes

- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- The opening row names the consignee after 收货人：, which the reader drops, as it does signers,
  drivers, plates and phones.
- A row's location is the hub it arrives at, or the branch that opened the waybill; the next stop a
  departure row names is not a location.
- The firm writes 己 for 已 in its rows; [`statuses.json`](statuses.json) keeps the wordings as written.

## Limitations

- The destination city and piece count stay in the opening row's wording; there is no weight.

## Numbers

The waybill numbers are bare runs of seven digits, which say nothing about the firm, so no rule
claims them and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`SZHST56_TRACKING_NUMBER=… SZHST56_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/szhst56`
