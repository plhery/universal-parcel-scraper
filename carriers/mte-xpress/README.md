# MTE Xpress

MTE Xpress parcels use enabled universal providers. There is no dedicated adapter.

MTE Xpress is a road and air freight courier based in Germiston, Johannesburg, with branches in
Gqeberha, Bloemfontein, East London, Pinetown, George and Cape Town. It delivers overnight to five
days across South Africa. Its site is mtexpress.co.za.

## Numbers

The public example is a nine-character Shiplogic reference of letters and digits. Only an
aggregator's example shows it, so there is no rule.

## Why there is no adapter

Its tracker is a Shiplogic portal, as [Internet Express's](../internet-express/README.md) is, whose
adapter reads the portal's shipment lookup with Internet Express's provider id. MTE Xpress's
provider id is not known, and no found reply has been seen.

## Links

`portal.mtexpress.co.za/track?ref=<number>` opens one parcel, and its Shiplogic subdomain,
mtexpress.shiplogic.com, redirects there.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
