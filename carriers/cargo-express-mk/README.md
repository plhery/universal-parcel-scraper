# Cargo Express

Cargo Express parcels use enabled universal providers. There is no dedicated adapter.

Cargo Express, Карго Експрес ДООЕЛ of Bitola, is a North Macedonian courier that delivers door to
door across the country, usually within a day, and runs parcel lockers. Its site is
kargoekspres.mk.

## Numbers

Its tracking page finds a shipment by its cargo code. No public page shows a whole code or its
layout, so there is no rule.

## Why there is no adapter

The tracking page is an ASP.NET form that posts the code with the page's view state and shows
the shipment's status. With no public code to check its replies against, there is no adapter.

## Links

Its tracker takes codes only through a form that posts them, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
