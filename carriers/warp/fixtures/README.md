Replies of WARP's `GET gw.wearewarp.com/api-tracking/{number}?fe=true` for public samples in
[`numbers.json`](../numbers.json), trimmed: the customer, the legs that repeat the shipment, the
stops' names, streets, references, coordinates and settings, and the proof-of-delivery links are
left out. `order-P-0044-2639.json` is the delivered order, `shipment-S-80215-2616.json` the
canceled test shipment. `not-found.json` is the stops service's answer for a number WARP does
not know, after the empty 404 of the tracking reply. The tests derive their other shipments from
the delivered sample with invented numbers.
