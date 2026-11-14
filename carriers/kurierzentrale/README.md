# KurierZentrale

KurierZentrale parcels use enabled universal providers. There is no dedicated adapter.

KurierZentrale, KurierZentrale GmbH of Basel, is a bicycle, cargo-bike, car and train courier for
the Basel region, the rest of Switzerland and abroad, medical transports included.

## Numbers

Its tracker finds a courier job by its order number, which the customer who books the job
receives. No public page shows a whole number or its layout, so there is no rule.

## Why there is no adapter

The site's Tracking link opens crm.kuz.ch, KurierZentrale's AuftragsZentrale, a booking platform
from PinkPost GmbH that [Veloblitz](../veloblitz/README.md) also runs under its own name. Booking
and order lists need a sign-in, but the "Track Auftrag" pop-up takes a job's number without one
and posts it back to the page. With no public number to check its replies against, there is no
adapter.

## Links

Its tracker takes numbers only through a form that posts them back to the page, so no address
opens one job.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
