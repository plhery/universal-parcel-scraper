# King Solutions

King Solutions parcels use enabled universal providers. There is no dedicated adapter.

King Solutions is a third-party logistics company in Dayton, Minnesota. It manages truckload and
less-than-truckload freight, consolidates shipments, delivers the final mile and enters mail at
USPS destination facilities. It gives shipments its own King pro numbers. Its site is
kingsolutionsglobal.com.

## Numbers

The only public example is SO, nine digits and SO, from an aggregator, so there is no rule.

## Why there is no adapter

Its tracking page is a GET form that takes up to thirty numbers in `pros`. Its script asks
`webapps.kingsolutionsglobal.com/KingREST/track/` for them.

## Links

`kingsolutionsglobal.com/track/?pros=<number>` opens one shipment. The page also finds a shipment
by the PRO number of the carrier moving it, so such a link can hold another carrier's number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
