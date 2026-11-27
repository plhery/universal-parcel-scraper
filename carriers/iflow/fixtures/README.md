`synthetic-order.json` is synthetic: no public number answers on iFLOW's tracker. It follows the order the
tracker's script reads from `GET /tracking/order/{tracking_id}` (`shippings`, each with `shipment_id`, `steps`
with their `states` and `estimatedDeliveryDate`), with the tracker's state wordings, and invented ids, clocks,
names and label link. It holds two shipments of one order.

`server-error.json` is the search's reply, HTTP 500, to the all-zero placeholder code: the reply it gives a code
it holds no record of.
