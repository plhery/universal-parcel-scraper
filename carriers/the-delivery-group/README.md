# The Delivery Group

The Delivery Group parcels use enabled universal providers. There is no dedicated adapter.

The Delivery Group (TDG) is a UK managed mail, packet and parcel company based in Warrington. It
delivers mail, packets, parcels and pallets across the UK and sends items abroad. Its site is
thedeliverygroup.co.uk.

## Numbers

Its tracking IDs are 8 to 30 letters and digits. That fits many other carriers' numbers, and no
public page shows one, so there is no rule.

## Why there is no adapter

Its tracking page is a TDG-styled page on DocketHub, a tracking platform other senders use too.
The page posts the reference, with an optional postcode, to
`tracking.dockethub.com/Shipment/trackShipment` and can show a partner's leg with its own link.
No public number is known to see a found reply.

## Links

`tracking.dockethub.com/shipment/<number>?style=TDG` opens one parcel. The page serves every
DocketHub sender and only its style parameter names TDG. A link rule cannot require that
parameter while it reads the number from the path, so there is no rule.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
