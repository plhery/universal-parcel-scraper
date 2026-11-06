# GRUBER Logistics

GRUBER Logistics parcels use enabled universal providers. There is no dedicated adapter.

GRUBER Logistics S.p.A. is a road haulier and forwarder in Ora (Auer), South Tyrol, with full and
part loads, groupage, heavy transport, air and ocean freight, and offices across Europe. Its site is
gruber-logistics.com.

## Numbers

Public examples are twelve characters: two letters or digits, then ten digits. Only an aggregator's
examples show them, so there is no rule.

## Why there is no adapter

Its tracker is a single-page app that reads `trackingId` from the address and asks its API gateway
for `tracking/order/<number>`, with a key the app gives every visitor. The gateway answers 404 for
an unknown number, 406 for a shipment too old to show and 422 when it cannot read the data. No found
reply has been seen.

## Links

`glapptracking.gruber-logistics.com/?trackingId=<number>` opens one shipment. The corporate site
does not link the tracker.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
