# YFHEX

YFHEX parcels use enabled universal providers. There is no dedicated adapter.

YFHEX is 原飞航物流 (深圳市原飞航物流有限公司, Shenzhen Yuanfeihang Logistics), a Shenzhen
cross-border forwarder whose site is yfhex.com. Universal providers name it YFH.

## Numbers

No public page shows a whole YFHEX number, so there is no detection rule. Parcels reach it
through a universal provider's carrier name.

## Tracker

The home page sends small-parcel and line numbers to `toms.yfhex.com:6055/track_query_c.aspx`
and other services to the same page on port 6010 over HTTP. The tracker asks
`Captcha/CaptchaHandler.ashx?action=IsNeedValidate` whether to show a picture check before it looks
a number up, so a dedicated adapter needs to handle that check.

## Links

The port 6055 tracker writes the number in `?track_number=` into its query box.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
