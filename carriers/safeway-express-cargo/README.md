# Safe Way Express Cargo

Safe Way Express Cargo parcels use enabled universal providers. There is no dedicated adapter.

Safe Way Express Cargo is a Bahrain carrier running land freight, last-mile delivery and
e-commerce logistics across the Gulf states, with branches in Saudi Arabia, the United Arab
Emirates and Oman. Its site is safewayxp.com.

## Numbers

Its tracking page's example is BH and eight digits, and its tracker answers it. It is one sample,
so the rule is low. Other branches may use other prefixes.

## Why there is no adapter

The tracking page is an open server-rendered page, without a session or CAPTCHA. Its example
shows a hand-off to Aramex with Aramex's number and no events of its own, which is too little to
build an adapter on.

## Links

The tracking page opens the number from its `awb` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
