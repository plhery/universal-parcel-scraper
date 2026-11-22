# Riyu Logistics

Tracks Riyu Logistics (日昱物流), a Guangzhou freight network, through the route its waybill
page shows.

## How it works

The site's tracking page opens `https://www.rywl.cn/cargoMap-<waybill>`, whose script posts to
`/ssm/order/orderTrack?omsNo=<waybill>`. `direct` sends that request with no session, captcha or
account. The reply lists the waybill's steps, each with a three-digit state code, its wording and
its China wall clock; every row must be the whole waybill asked, and an empty list is a waybill
Riyu does not know. A request that fails to reach the server gets one `retry` in the rest of the
budget.

The state code is the provider code and the site after the wording's colon the location. The
rows' phone numbers and operator field are left out, and the page's other request, which returns
the sender's and recipient's names and addresses, is not made.

## Limitations

The endpoint orders the steps by state, not by clock, and a step's clock is sometimes written
after the delivery's; the rows keep its order. Waybills are a letter and ten digits, a shape
other carriers share, so the carrier is never detected and needs explicit selection.

## Testing

`RIYU_LOGISTICS_TRACKING_NUMBER=… RIYU_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/riyu-logistics`
