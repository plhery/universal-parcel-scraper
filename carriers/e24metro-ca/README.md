# E24

E24 parcels use enabled universal providers. There is no dedicated adapter.

E24 is the e-commerce and home delivery service of Metro Supply Chain, a Montreal logistics company,
delivering parcels and large items for Canadian retailers. Its site is metroscg.com.

## Numbers

No public page shows an E24 number, so there is no rule.

## Why there is no adapter

E24 parcels are tracked on FarEye, a delivery management platform, at `tracking-ca.fareye.co`.
The retailer's notice links a `universal-tracking` page whose query is an opaque token for one
parcel. Plain HTTP reads it: `get_tracking_details?url=<token>` gives the reference fields and
`get_last_mile_and_status_details` the statuses, without a session or CAPTCHA. A lookup by number
goes through a merchant's `universal-search` page, which sends the number to
`get_universal_tracking_url` with that merchant's `encodedString`; the service refuses a merchant
code without it. No merchant's search page is public, so no lookup starts from a number. The former
portal's domain, e24metro.com, is parked, and Metro Supply Chain's site has no tracker.

## Links

Only the retailer's notice links a parcel's page, so no address can be built from a number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
