# GJS Express

GJS Express (光捷速运) ships parcels from Japan to China: its shops in Tokyo take them in, its
warehouse sends them on ZTO International's lines, and ZTO or another domestic courier delivers them
after clearance. Its tracking page lists the firm's rows and its partners' together.

## How it works

1. `direct`: one `POST https://d2dykdfpvf684s.cloudfront.net/common/getPackageTrackInfo` with
   `{"packageNo":null,"expressNo":"<number>"}`, the request the tracking page at h5.guojisuyunjapan.cn
   sends, with no session or token. The service refuses a form body.
2. `retry`: one more try when the request fails to reach the service or hangs.

- Code 500 with 未查询到对应包裹信息 is the answer for an unknown number; another refusal is
  inconclusive. CloudFront's HTTP 403 and a bot-check page are challenges.
- The service takes the parcel number with or without GJS, or the domestic waybill. The reply's
  parcel number (`packageNo`) or domestic waybill (`expressNo`) must be the number asked, and each row
  must name the same parcel.

## Notes

- Only the rows and the two numbers are read. The parcel record beside them holds the recipient's and
  sender's names, phones, addresses and identity card, and is never kept.
- Rows copy ZTO's sentences, which name the courier and their mobile, the signer, the pickup point and
  branch phones, and end on a courtesy: all are left out. A row keeps the place it starts with: the
  firm's city in Latin letters, a place in 【】, or the first ZTO site in brackets.
- Every row is dated on China's clock with `carrier` as the basis, the firm's Tokyo rows too: its
  warehouse's intake and ZTO International's, both on China's clock, are a minute apart on the example.
- The domestic waybill is given as ZTO's when it has ZTO's shape and a row names ZTO.
- The wordings are in [`statuses.json`](statuses.json).

## Limitations

- No weight, contents or destination: they are in the parcel record, which is not read.

## Numbers

The parcel numbers seen are GJS and twelve digits. No rule claims them, as the firm does not publish
the format, so the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`GJSGUOJI_TRACKING_NUMBER=… GJSGUOJI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gjsguoji`
