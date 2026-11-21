# CMT Express

Tracks shipments of CMT Express (诚贸通供应链), run by Shenzhen Chengmaotong Supply Chain, which
resells DHL, FedEx, UPS, TNT and USPS services and Guangzhou small-parcel lines from China, and
runs its own lines, such as one to Europe. Its site is cmtexpress.com.cn.

## How it works

CMT Express runs its own tenant of the Hualei (华磊) platform at `tms.cmtexpress.com.cn`, the
hosted system behind the site's waybill query. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, place cleaning and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says CMT Express holds the number.

The tracker's HTTPS host gives the same answers as plain HTTP on its port 8082, so the number
never travels in the clear. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The platform writes its order row in Chinese, which the adapter shows in English, and the
  shipper's order and the warehouse's receipt in English. Rows are read on the platform's Beijing
  clock.
- The warehouse rows give Shenzhen as `SZ.`, which as a code is Eswatini's, so those rows carry no
  place; their wording names the Shenzhen warehouse.
- The record's product name is the service name. The record's own summary status is not read: the
  rows decide the stage.
- A tracking number of another shape than CMT Express's own is taken for the delivery carrier's,
  as on the platform's other tenants, and returned as the delivery tracking number without a
  carrier.

## Limitations

- No record has named a delivery carrier yet, so no line hands the parcel to one.
- The product names are kept in Chinese: the platform's shared table does not know the line's
  terms.

## Numbers

Its waybills are CMT and twelve digits. No other carrier's rule takes the shape, but three letters
say little, so the rule is low and recognition asks the tracker. No public number has been found,
so the corpus holds a synthetic one.

## Links

`tms.cmtexpress.com.cn/en/trackIndex.htm?documentCode={number}` opens one parcel on the tracker's
English page, over HTTPS. The search page is the site's waybill query.

## Testing

Set `CMT_EXPRESS_TRACKING_NUMBER` (and `CMT_EXPRESS_UNKNOWN_NUMBER` for the not-found answer)
outside the repository and run `npm run test:carriers:live -- carriers/cmt-express`.
