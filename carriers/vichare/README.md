# Vichare Loginext

Vichare Loginext parcels use enabled universal providers. There is no dedicated adapter.

Vichare Loginext is a Mumbai courier. It carries domestic express parcels, delivers within a few
hours around Mumbai, Thane and Navi Mumbai, and handles cash-on-delivery, business and appointment
deliveries. International parcels go through partners. Its site is vichareloginext.com, which
vichare.com frames.

## Numbers

Its tracking page finds a shipment by AWB number, order id or mobile number. No public page shows
an AWB number and their format is unknown, so there is no rule.

## Why there is no adapter

Its tracking page posts the AWB number, order id or mobile number through a form to
`/Home/TrackShipment`. No public number is known to see a found reply.

## Links

The tracking page takes the number in a POST form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
