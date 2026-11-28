# Wing

Wing shipments use enabled universal providers. There is no dedicated adapter.

Wing, from Paris, ships online shops' orders: it prints labels with partner carriers, picks up and stores goods,
and gives the recipient its own tracking page.

## Numbers

Parcels travel under the partner carriers' numbers, which the tracker also takes, so there is no rule.

## Why there is no adapter

Each lookup needs the number and the delivery postcode (`GET /api/order-search`), and the answer opens under Wing's
internal order id. With no public number to check the tracker's replies against, there is no adapter.

## Links

The result opens under Wing's own order id, not the number, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
