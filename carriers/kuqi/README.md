# Kuqi Supply Chain

Kuqi Supply Chain parcels use enabled universal providers. There is no dedicated adapter.

Kuqi Supply Chain (库奇, SZKUQI on 17TRACK) is a Shenzhen forwarder that ships cross-border
e-commerce parcels and Amazon FBA freight from China to North America and Europe. Its site,
kuqi56.com, serves over HTTP only; its Track Order menu sends customers to its tenant page on
the ollogistic.com logistics platform, which serves over HTTPS, so the catalog uses that page.

## Numbers

No public page shows a Kuqi waybill number, so there is no rule.

## Why there is no adapter

The tenant page's script posts numbers to the platform's JSON tracking endpoint without a login.
With no public number to check its replies against, there is no adapter.

## Links

The tracking page opens numbers from its `code` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
