# FedEx International Connect

FedEx International Connect parcels use enabled universal providers. There is no dedicated adapter.

FedEx International Connect (FIC) is FedEx's economy cross-border service from Britain, run from
its own hubs, which grew out of P2P Mailing. FIC carries a parcel abroad and hands it to a partner
carrier, usually the destination's post, which delivers it under its own number. FedEx
International Connect Plus is a different service on FedEx Express's network, tracked by FedEx with
FedEx's numbers. The old FedEx Cross Border front door now leads to FedEx's American eCommerce
Connect, so that name is not an alias.

## Numbers

An FIC tracking number is three letters naming the shipper, four digits, the country the shipper
sends from and eleven digits. FIC's tracker labels it "FIC Tracking Number", and archived lookups
there show it behind many shippers' letters, so detection selects FIC for it.

## Tracker

`https://fictracking.fedex.com/?MyFICNumber=…` answers with an HTML page and no challenge. It looks
up an FIC tracking number, the partner's number or the shipper's reference, and says it has no
record of an unknown or expired one; records last about a year. A known parcel shows its
destination, service, partner number, the partner's local number and a history of date, activity,
event code and location rows, opening with "EXPECTED FROM" and the shipper's name. A dedicated
adapter could read that page.

## Links

A link to the tracker with `MyFICNumber` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
