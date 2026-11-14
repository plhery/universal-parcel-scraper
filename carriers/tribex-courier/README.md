# Tribex Courier

Tribex Courier parcels use enabled universal providers. There is no dedicated adapter.

Tribex Courier, Tribex Courier sh.p.k. of Tirana, is an Albanian courier for e-commerce senders,
with deliveries across Tirana and the rest of Albania. Its tracker is a white-label E-COURIER PRO
portal, as [Intex Courier](../intex-courier/README.md)'s is.

## Numbers

The portal finds a parcel by its track code and takes several codes at once. The field's example
is the platform's own, and no public page shows a whole code or its layout, so there is no rule.

## Why there is no adapter

The portal's form posts the codes with a session token. With no public code to check its replies
against, there is no adapter.

## Links

Its pages take codes only through a form that posts them, so no address opens one parcel. The
platform's GET route, which Intex Courier's site links to, is not one Tribex Courier publishes.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
