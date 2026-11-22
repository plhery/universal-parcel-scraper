# Hongtai Logistics

Tracks Hongtai Logistics (鸿泰物流), a Zhengzhou less-than-truckload network across Henan and
its neighbouring provinces, through the waybill search on its own site.

## How it works

The search page at `https://www.ht56.com/orderSearch.html` posts the waybill as JSON,
`{"orderNo": "<waybill>"}`, to
`https://www.ht56.com/tms-htwl/tmsOpenApi/selectEventRouteForeignByOrderNo`. `direct` sends the
same request with no session, captcha or account. A request that fails to reach the server gets
one `retry` in the rest of the budget. An unknown waybill comes back with no rows.

Every row must be the whole waybill asked. A row's node name, such as 卸货入库, is its code and its
branch the location. Rows state their instant in epoch milliseconds beside a China wall clock; the
adapter returns the instant after checking that the two agree. The wording comes from the row's
log, without the phone numbers, plates, drivers, load numbers and signatory it carries. A transfer
to a partner carrier keeps the partner's name, waybill and station.

整车签收 is the destination branch signing for the whole truck, not the recipient, so it stays in
transit.

## Limitations

Waybills are nine digits, a shape other carriers share, so the carrier is never detected and needs
explicit selection. The partner carrier's own tracking is not followed.

## Testing

`HONGTAI_LOGISTICS_TRACKING_NUMBER=… HONGTAI_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/hongtai-logistics`
