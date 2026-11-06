# Walker Logistics

Walker Logistics parcels use enabled universal providers. There is no dedicated adapter.

Walker Logistics is a New Zealand courier and freight company in Auckland and Christchurch. It
runs overnight courier as Walker Courier, economy and road freight services, and air and ocean
freight with customs clearance. It is not Walkers Transport, a different company. Its site is
walkerlogistics.co.nz.

## Numbers

The only public example is six letters and six digits, from an aggregator, so there is no
rule.

## Why there is no adapter

Its tracker is a Tempo page on the carrier's own `walkerlogistics.tempo.delivery` subdomain, an
AngularJS app that reads the number from the fragment's route and asks the host's
`/trackerapi/api/v1/` for it.

## Links

`walkerlogistics.tempo.delivery/tracker/#/<number>` opens one consignment. The rule reads only
the carrier's own Tempo subdomain.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
