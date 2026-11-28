# Boxme

Boxme shipments use enabled universal providers. There is no dedicated adapter.

Boxme runs e-commerce fulfilment, last-mile delivery and cross-border shipping from Ho Chi Minh City and Bangkok.

## Numbers

The tracking form's placeholder is an example, not a shipment, and no public page shows one of its numbers,
so there is no rule.

## Why there is no adapter

The tracker sits behind a Cloudflare challenge and reads `https://track.boxme.asia/api/v1/orders/journey/<number>/`.
It can redirect to the delivering carrier's own page. With no public number to check the tracker's replies against, there is no adapter.

## Links

`track.boxme.asia/?tracking_number=<number>` opens one shipment; the page's own search writes that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
