# JLog

JLog parcels use enabled universal providers. There is no dedicated adapter.

JLog is the brand of JetLog (Pty) Ltd in Cape Town. It runs e-commerce fulfilment, warehousing,
customs clearing, sea and air forwarding and fine-art crating, and delivers with its own vehicles,
including regional runs to the Garden Route. Its international parcels travel with FedEx and DHL
and its domestic ones partly through Bob Go, MDS Collivery and EMIT. Its site is jlog.co.za.

## Numbers

Its tracker takes JLog references and FedEx, DHL, Bob Go, MDS Collivery and EMIT waybills,
usually seven to fourteen letters and digits. No public page shows a JLog reference, so there is
no rule.

## Why there is no adapter

Its tracking page is a WordPress page at `jlog.co.za/tracking/<reference>`. Its own platform
answers `GET app.jlog.co.za/api/track/agent?ref=<reference>`, a path its robots.txt disallows.
No public number is known to see a found reply.

## Links

`jlog.co.za/tracking/<number>` opens one shipment. The link names JLog only for its own
references, so a partner's waybill in it is detected on its own.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
