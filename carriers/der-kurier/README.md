# DER KURIER

DER KURIER parcels use enabled universal providers. There is no dedicated adapter.

DER KURIER, DER KURIER GmbH & Co. KG of Neuenstein (Hesse), is a German courier and express network
of independent stations whose parent company is GLS. It delivers parcels across Germany, reaches
several European countries through its partner network and sends to the rest through GLS. Its site
is derkurier.de. [DER KURIER Slovakia](../der-kurier-sk/README.md) is a separate company.

## Numbers

Its tracking page asks for the first 11 digits of the parcel label's number. The tracking widget
reads 11 characters as a parcel number and 12 as one with a check digit, which it drops. It also
takes a sender's order id, three digits, an underscore and the id, up to 25 characters in all, and
a station reference, three digits, a colon and the reference. When an 11-character number with 8
and 5 in third and fourth place finds nothing, the widget moves that 8 to the front, the layout
its code marks as GLS's, and asks again. No public page shows a whole number, so there is no rule.

## Why there is no adapter

The widget asks DER KURIER's JSON service for the order behind the number, then for its status;
with the recipient's postcode, which is optional, it shows each parcel's details. With no public
number to check its replies against, there is no adapter.

## Leads

On api.derkurier.de, `GET /rs/api/v1/order/find` with `parcel-no`, `external-id` or `reference`,
and `archive=true`, returns the order id. `GET /rs/api/v1/order/status` with that `id` and an
optional `zip-code` returns the order's status and parcels.

## Links

`https://derkurier.de/sendungsverfolgung/?d-pt-search={trackingNumber}` opens the tracking page on
the number. The library reads the number from that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
