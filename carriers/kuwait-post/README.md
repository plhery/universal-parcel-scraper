# Kuwait Post

Kuwait Post parcels use enabled universal providers. There is no dedicated adapter.

Kuwait Post is Kuwait's national postal service, run by the Ministry of Communications.

## Numbers

It gives international items UPU S10 numbers ending in `KW`. Generic postal detection handles these
numbers, so no rule for Kuwait Post claims them.

## Why there is no adapter

The tracking page on moc.gov.kw sends the number with a Google reCAPTCHA v2 checkbox answer to a
Next.js server action, `submitShipmentTracking`, which checks the answer (`captcha_invalid`
otherwise) and limits how often it answers (`rate_limit_exceeded`, with a wait in seconds). Its
other refusals are `no_data_found` and `tracking_unavailable`. No public number is known to check
its tracker's replies against.

## Links

The form sends the number with the CAPTCHA answer and shows the reply on the same page, so there are
no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
