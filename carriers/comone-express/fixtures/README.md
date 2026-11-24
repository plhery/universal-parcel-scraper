# Fixtures

Replies of `POST service.com1logistics.com//pod/track/query`, the lookup ComOne's tracking page posts each
number to.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a parcel from
  Shenzhen delivered in Singapore. Trimmed to the parcel's waybill, status, countries, supplier and scans: the
  merchant's order number, the weights, internal ids, the remarks, which name the driver, and the delivery
  photos and signature are left out.
- `not-found.json`: the reply, with HTTP 200, for an invented number.
