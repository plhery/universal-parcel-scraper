# ZTO Freight

Tracks ZTO Freight (中通快运), ZTO's less-than-truckload and heavy-parcel network in China,
through the guest waybill search on its own site. ZTO Express parcels stay with `zto`.

## How it works

`direct` reads `https://www.zto56.com/api/qry/ewb_info?billCodes=<waybill>`, the call the
waybill search page makes once its slider is solved. The slider is checked in the browser
only: the call needs no ticket, cookie or account. It does need the page's JSON content type,
origin and address as referrer; without them the reply leaves every waybill out. The origin
matters because fetch adds `Sec-Fetch-Mode`, which the tracker then expects to come with one. `retry` repeats
the read once when the network fails.

The page puts `ZY` in front of a waybill that starts with 2024, so the adapter does too. The
reply must name the whole requested waybill.

Scans keep `scanDate` as a China wall clock. The carrier's own wording names couriers and their
phone numbers, so each scan's wording is rebuilt from its type and the branches it names;
only a problem scan's reason is read from it. Shipper remarks and the signatory are left out.
The reply's `predictTime` becomes the delivery estimate until the freight is signed for.

## Limitations

The reply leaves `data` out for a waybill the tracker does not hold, which is also how it
answers a request without the page's headers; the live test watches for that. Only `ZY` with
twelve digits is detected; the numeric waybills from 3 and 8 share their shape with other
Chinese carriers, so they need explicit selection.

## Testing

`ZTO_FREIGHT_TRACKING_NUMBER=… ZTO_FREIGHT_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/zto-freight`
