# Chinz Logistics

Chinz Logistics consolidates parcels between China, New Zealand and Australia.
Parcelmate is its consumer brand. Select Chinz Logistics explicitly and enter its order number.

## Retrieval

The [carrier portal](https://chinzlogistics.com/en/consult) reads an open JSON endpoint at
`nz-cn.parcelmate.vip/api/comm/order/logic`. The adapter requests one order and checks the
whole returned order number. A body that explicitly reports no tracking records is a miss.

The order history includes Chinz movements and can include scans from the next carrier.
The adapter keeps the clocks as printed because the API provides no offsets and spans
several countries. It reads the main order timeline, folds identical scans, and marks the
history partial when the response includes separate parcel timelines. It leaves transfer
numbers and driver contacts out of the result.

## Testing

`CHINZ_LOGISTICS_TRACKING_NUMBER=… CHINZ_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/chinz-logistics`
