# Optima Overnight

Optima Overnight parcels use enabled universal providers. There is no dedicated adapter.

Optima Overnight (Optima Courier, Inc.) is a next-day last-mile carrier in Massachusetts,
Connecticut, Rhode Island and New Hampshire. Its site is shipoptima.com; optimacourier.com
redirects there.

## Numbers

Its tracking numbers are `P` and fourteen digits, as two numbers its own tracking page carried
in archived captures show. `optima-overnight-1` suggests it at low confidence:
[TransMission](../transmission/README.md)'s rule takes the same layout.

## Why there is no adapter

Its tracking page reads an open JSON lookup on distribution.shipoptima.com without a session,
and it answered both public numbers; an adapter is possible and not yet written. A found reply
carries the recipient's name and delivery photos, which an adapter would have to leave out.

## Links

The tracking page opens a number from its `tracking` parameter; its older form used
`trackingNumber`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
