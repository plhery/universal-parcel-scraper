# Veloblitz

Veloblitz parcels use enabled universal providers. There is no dedicated adapter.

Veloblitz, the cooperative Genossenschaft Veloblitz of Zurich, is a bicycle courier founded in
1989 that also delivers by car and train, in Zurich, across Switzerland and abroad.

## Numbers

Its tracker finds a courier job by its order number, which the customer who books the job
receives. No public page shows a whole number or its layout, so there is no rule.

## Why there is no adapter

Its customer portal, veloblitz.kuz.ch, is its white-label of AuftragsZentrale, the booking
platform from PinkPost GmbH that [KurierZentrale](../kurierzentrale/README.md) runs on kuz.ch.
Booking and order lists need a sign-in, but the portal's "Track Auftrag" pop-up takes a job's
number without one and posts it back to the page. With no public number to check its replies
against, there is no adapter.

## Links

Its tracker takes numbers only through a form that posts them back to the page, so no address
opens one job.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
