# Siuntos autobusais

Siuntos autobusais parcels use enabled universal providers. There is no dedicated adapter.

Siuntos autobusais is the parcels-by-bus service of UAB Kautra, a Kaunas bus operator. Parcels
travel on intercity buses between terminals at bus stations across Lithuania, run by Kautra or by
partner bus companies, and wait at the destination terminal for the recipient.

## Numbers

Its tracking page finds a parcel by its order number. No public page shows a whole number or its
layout, so there is no rule.

## Why there is no adapter

The tracking form posts the number back to its page, whose script then asks the site's WordPress
handler for a table of the parcel's events. With no public number to check its replies against,
there is no adapter.

## Links

Its tracker takes numbers only through a form that posts them, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
