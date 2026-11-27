# POSTA express

POSTA express items use enabled universal providers. There is no dedicated adapter.

POSTA express is a franchise network of private post offices run by P.S.T. Consulting of
Battipaglia, which owns the brand, for registered mail, coded ordinary mail and urban parcels. The
company and its franchisees are on the Italian Ministry of Enterprises' register of postal operators.

## Numbers

The tracking form accepts 12 to 17 digits, the code on the acceptance receipt. No public page shows a
real number, so there is no rule.

## Why there is no adapter

The tracker posts the number as `NumSped`, with the period it was sent in (within 6, 6 to 12, 12 to
18 or 18 to 24 months) as `DataSped`, to `trackingonline.asp`, which answers with a server page.
With no public number to check its replies against, there is no adapter.

## Links

The tracker takes the number only from its form, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
