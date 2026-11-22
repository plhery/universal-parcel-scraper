Replies of JustShip's `GET /api/shipment/tracking?trackingNumber=`. `shipment-240915A001R01.json` is
the reply to the public sample in [`numbers.json`](../numbers.json), the example the tracking page
gives in its search field, with the package's internal row key zeroed. `not-found.json` is the
answer for a shipping ID JustShip does not know. The tests derive their other shipments from the
sample with invented shipping IDs.
