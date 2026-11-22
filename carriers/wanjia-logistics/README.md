# Wanjia Logistics

Tracks Wanjia Logistics (万家物流, Manco Logistics), a Shanghai e-commerce shipper whose parcels
travel on national express networks, through the tracking page its site frames.

## How it works

The site's 货物追踪 page loads a script that frames
`http://cn.manco-logistics.com:8606/WangJTaoBaoInterface/wjwl/query.do?nu=<waybill>` for the
waybill typed in. `direct` reads that page with no session, captcha or account. The page names the
waybill, which must be the whole number asked, and lists its scans newest first on China wall
clocks; a page saying it found nothing is a waybill Wanjia does not know. A request that fails to
reach the server gets one `retry` in the rest of the budget. Both hosts answer over HTTP only.

The scans are those of the network carrying the parcel, so their wording varies. A row has no
scan code; the adapter names it after the phrase its wording is built around, such as 已揽收 or
发往, and takes the region the row opens with, as `[天津市,宁河区]`, or a bracketed city, as its
location. A row naming a partner's waybill for the last leg keeps it. The pickup code, couriers,
collectors and phone numbers are removed, as are the lines asking the recipient to call.

## Limitations

Waybills are fourteen digits, a shape other Chinese carriers share, so the carrier is never
detected and needs explicit selection. A transfer warehouse that relabels a parcel for another
network ends Wanjia's history.

## Testing

`WANJIA_LOGISTICS_TRACKING_NUMBER=… WANJIA_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/wanjia-logistics`
