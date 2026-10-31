# Wiio

Wiio parcels use enabled universal providers. There is no dedicated adapter.

Wiio, formerly Sumai, is a Hangzhou dropshipping platform. Its parcels travel on its own line,
PD Express (蓬达, Hangzhou Pengda Technology), which hands them to the destination's carriers. Its
site is wiio.com.

## Numbers

A store owner's post shows ZLX, two letters, ten digits and two letters, and PD Express's tracker
answers it. It is one sample, so the rule is low.

## Why there is no adapter

PD Express's tracker is a Hualei tenant on plain HTTP, whose open JSON lookup answers the public
number without a session or CAPTCHA. The shared Hualei client can follow.

## Links

The tracker is HTTP only, so the catalog opens Wiio's site. A tracker link opens the number from
its `documentCode` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
