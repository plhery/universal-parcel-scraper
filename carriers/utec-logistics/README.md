# UTEC Logistics

UTEC Logistics parcels use enabled universal providers. There is no dedicated adapter.

UTEC Logistics (UTEC Group) is a Kyiv freight forwarder bringing goods into Ukraine from China, Hong Kong,
Poland, the United States and elsewhere. Its parcel line, UTEC Express, carried AliExpress orders from China
to Ukraine and handed them to Ukrposhta for delivery. Its site is utec.ua; utec.info, the address 17TRACK
lists for it, now leads there.

## Numbers

UTEC Express numbers are `UTECP`, ten digits and two letters, `YQ` on every public one. Reviews on its
vidhuk.ua page quote four, one of them in the company's own reply. They all come from that one site, so
`utec-logistics-1` is low, though no other carrier uses the prefix.

## Why there is no adapter

Its tracking page, `utec.ua/tracking/{number}`, sits behind a Cloudflare challenge that plain requests and an
automated browser did not pass, so the request behind it is unknown.

## Links

The tracking page reads the number from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
