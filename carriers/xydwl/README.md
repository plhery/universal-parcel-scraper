# Xinyuda Logistics

Xinyuda Logistics (鑫宇达物流) is a road and air freight firm based in Shenzhen. Its site's result
page (`result.html?content=<number>` on xydwl.cn) asks the firm's own tracking service for the
waybill's rows, which Kuaidi100's carrier list links as the firm's tracker.

## How it works

1. `direct`: one `POST http://112.74.160.148:8086/glkj/customerservice/customerservicetrack/getOutSideTracks`
   with `{"waybillCode":"<number>"}`, the request the result page sends, with no cookie or session.
2. `retry`: one more try when the request fails to reach the service or hangs.

- The reply keys each waybill it found to its rows. A successful reply without the number asked is
  not found, a key other than the number or a row for another waybill is a changed reply, and a
  reply with another code is inconclusive.
- Each row's template (`templateNode`) is its provider code and sets its stage through
  [`statuses.json`](statuses.json); a template the map does not know is staged by its wording when
  the shared rules read it.

## Notes

- The service and the site are served over plain HTTP (the site's certificate has expired), so the
  catalog gives no tracking link.
- Rows are dated on China's clock with `carrier` as the basis, each keeping its wall clock.
- The delivery row names the signer in brackets, which the reader drops, as it does drivers and
  phones. The rows also name the staff who keyed them, which is not read.

## Limitations

- The rows name no place, so no location, origin or destination.
- Waybills are often keyed only when opened and when signed for, so many show two rows.

## Numbers

The waybill numbers are a counter of seven digits, which says nothing about the firm, so no rule
claims them and the adapter answers explicit selection. It declares no recognition: the counter is
dense, so a waybill under a number does not show the parcel asked about is the firm's. The samples
and their sources are in [`numbers.json`](numbers.json).

## Testing

`XYDWL_TRACKING_NUMBER=… XYDWL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/xydwl`
