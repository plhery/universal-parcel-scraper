# TopYou

TopYou parcels use enabled universal providers. There is no dedicated adapter.

TopYou is 深圳市通邮物流科技（集团）股份有限公司 (通邮集团), a Shenzhen cross-border forwarder with
international lines, whose site is szty56.com.

## Numbers

Its waybills are TYZR, a letter, ten digits and YQ. Forwarders on the Hualei (华磊) platform end
their waybills with YQ and open them with their own code, as [Juxi Express](../juxi-express/README.md)
does. A sample on ParcelPanel's TopYou page and a parcel a universal provider files under TopYou
share the layout, TopYou's own tracker answers the sample, and no other carrier's rule takes it, so
`topyou-1` has high confidence.

## Tracker

`track.szty56.com` posts `{"ids": [number]}` to `/order/track` and gets JSON: one entry per number
with its scans, each with a clock, a `timeZone` offset, a status code and an English wording. No
token or session is needed, so a dedicated adapter could read it directly.

## Links

The tracker reads the number from its form only, so no link opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
