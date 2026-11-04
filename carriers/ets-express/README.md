# ETS Express

Tracks ETS Express (俄通收) parcels by their own RETS shipment number. Ozon posting references
stay with [Ozon](../ozon-logistics/README.md); they do not identify ETS shipments by themselves.

## How it works

`direct` reads the guest Hualei tracker at `1.12.55.94:8082`, over plain HTTP without an account
or session. The [official inquiry page](https://www.ets-express.com/inquiry.html) and its
[request builder](https://www.ets-express.com/upload/js/21fea6ed55bf4dffae261a3dc3887f17.js)
use `selectTrack.htm?documentCode=<number>`. A positive reply must carry the whole RETS invoice
or tracking number and name a RETS service.

The interface's no-track reply also covers orders without scans. A POST of the same
`documentCode` to `trackIndex.htm` confirms absence only when it renders one empty waybill
for that exact number. A positive page that only shows an Ozon posting cannot bind the RETS
shipment. The inquiry page's demo fallback is never read.

## Limitations

Scan clocks keep their local wall times because the feed states no offset. The shared
[Hualei parser](../gzyl/hualei.ts) holds back custom-trajectory and written-ahead rows and
retains truncation flags. References do not become canonical ETS numbers or delivery handoffs.
A block, throttle or malformed reply ends the lookup.

## Testing

`npm run test:carriers:live -- carriers/ets-express`, with `ETS_EXPRESS_TRACKING_NUMBER` and
optionally `ETS_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
