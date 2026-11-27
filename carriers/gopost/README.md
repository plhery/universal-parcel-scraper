# GoPost

GoPost shipments use enabled universal providers. There is no dedicated adapter.

GoPost is the international express service of Tín Phát Express in Ho Chi Minh City, which consolidates
shipments abroad. It is on Ho Chi Minh City's register of postal enterprises.

## Numbers

No public page shows one of its codes, so there is no rule.

## Why there is no adapter

The tracker reads `https://api.tinphatexpress.vn/api/v2/tracking/<code>`, and other paths for its partners'
legs. With no public code to check its replies against, there is no adapter.

## Links

`trackinggopost.com/?tpCode=<code>` opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
