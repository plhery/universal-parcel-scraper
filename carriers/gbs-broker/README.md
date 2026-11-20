# GBS

Select GBS to read the customs and warehouse history of a cross-border consignment.
The public tracker accepts a single reference and repeats it on the matching result card.

Scans keep the offset shown on the result. Release and departure from customs advance
the shipment to in transit. Delivery continues with the company chosen by the sender.

A public reference is RLAI and eight digits, which rule `gbs-broker-1` suggests GBS for.

Set `GBS_BROKER_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/gbs-broker`.
