# Express Freight

Express Freight parcels use enabled universal providers. There is no dedicated adapter.

Express Freight is the Northern Ireland carrier based in Craigavon. It moves pallets, parcels and
general freight on daily routes across Northern Ireland and to the Republic of Ireland, Great
Britain and Europe. Its site is expressfreight.co.uk.

DX Group owns it, but it keeps its own network, consignment numbers and tracker, so it has its own
entry beside [DX](../dx/README.md). The "Express Freight Network" of New Zealand's
[PBT](../pbt/README.md) is unrelated.

## Numbers

Its consignment numbers have no published layout. The only public example, on an aggregator's page,
is a postal item number of another network's shape, so it is not kept and there is no rule.

## Why there is no adapter

Its tracking page is a GET form that sends `number_txt` to `track/view`. No found page has been
seen. The header's Track button opens a separate proof-of-delivery portal on a non-standard port.

## Links

`www.expressfreight.co.uk/track/view?number_txt=<number>` opens one consignment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
