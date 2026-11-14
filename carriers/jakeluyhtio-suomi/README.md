# Jakeluyhtiö Suomi

Jakeluyhtiö Suomi parcels use enabled universal providers. There is no dedicated adapter.

Jakeluyhtiö Suomi, Jakeluyhtiö Suomi Oy of Vantaa, is a Finnish home-delivery network owned by
Finnish media houses. Its carriers bring newspapers, addressed letters, direct mail and small
parcels from online shops to the door or mailbox across Finland. Its tracker shows a parcel's
stages and expected delivery day, and the other tracking code of a parcel that has one.

## Numbers

Its tracker asks for the shipment number (lähetystunnus). No public page shows a whole number or
its layout, so there is no rule.

## Why there is no adapter

The tracking page reads the number from its address and asks a JSON service for the shipment's
history, which can hold several shipments for one number. With no public number to check its
replies against, there is no adapter.

## Links

`https://seuranta.jakeluyhtio.fi/seuranta/{trackingNumber}` opens the tracker on the number, as
the form on jakeluyhtio.fi does. A pasted link on that host, also under its Swedish and English
paths `/uppfoljning/` and `/tracking/`, names Jakeluyhtiö Suomi.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
