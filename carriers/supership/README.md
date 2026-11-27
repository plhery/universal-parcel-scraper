# SuperShip

SuperShip shipments use enabled universal providers. There is no dedicated adapter.

SuperShip delivers online shops' orders across Vietnam from Ho Chi Minh City. It is on Vietnam's list of licensed postal enterprises.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

The tracker asks `POST https://api.mysupership.vn/v1/partner/orders/tracking` for each lookup, with a reCAPTCHA
answer in a header. With no public number to check its replies against, there is no adapter.

## Links

`tracking.supership.vn/?code=<number>` opens one shipment; the site's own search box links there.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
