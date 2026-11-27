# Fixtures

- `delivered.json`: the service's reply for the Kuaidi100 test number in `numbers.json`, delivered to an Amazon
  warehouse in California.
- `in-transit.json`: the service's reply for the example order on Kuaidi100's HUBO page, at sea, with the newer
  rows' countries and cities.
- `not-found.json`: the service's whole reply for an invented order number, far from any range in use.

Both replies are trimmed: `createBy` and `updateBy` (the staff who wrote each row), `annexUrl` and `annexName`
(pictures of the receipt) and `customerOrderCode` (the shipper's Amazon shipment) are removed, and the warehouse's
street in `destAddress` is replaced by a synthetic one.
