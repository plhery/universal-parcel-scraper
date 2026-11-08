# TCI Freight

TCI Freight parcels use enabled universal providers. There is no dedicated adapter.

TCI Freight is the road freight division of Transport Corporation of India Ltd. It carries full
and part truckloads and oversized loads across India. It is a different company from TCI Express,
which has its own catalog entry. Its site is tcifreight.in.

## Numbers

Its consignment (CNS) numbers are nine characters, as the tracker's validation says. That length
fits many carriers, and no public page shows one, so there is no rule.

## Why there is no adapter

Its tracking page posts the consignment number through a WordPress form and then opens an address
the server returns. The TCI group's tracker, a JavaScript app for road, rail, sea and air
shipments, asks for an image code before it searches.

## Links

The tracking page takes the number in a POST form, and the group tracker's search asks for an
image code, which the catalog does not link around. No address opens one consignment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
