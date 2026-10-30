# TA-Q-BIN Hong Kong

TA-Q-BIN Hong Kong parcels use enabled universal providers. There is no dedicated adapter.

TA-Q-BIN Hong Kong is the TA-Q-BIN (宅急便) parcel service of Yamato Logistics (HK), a Yamato Holdings company
delivering parcels within Hong Kong, Apple's shipments among them. Its own Hong Kong trackers follow its parcels,
not Yamato Transport's Japanese one. Its site is yamatohk.com.hk.

## Numbers

Its waybill numbers are twelve digits whose last digit is the remainder of the first eleven divided by seven, the
layout of Yamato Transport's TA-Q-BIN waybills in Japan. Yamato Transport's rule takes that shape, so there is no
rule of its own. The home page sends numbers with prefixes such as `HK20` or `1848` to its e-commerce parcel
system; their layout is not public.

## Why there is no adapter

Its tracking page blocks plain HTTP clients and hands waybill numbers to a page hosted by message.sg. That page
posts the number as `keyTrackingNumber` to an open JSON endpoint on delivery.message.sg,
`/YTHKws/wsWebsite.asmx/external_waybill_fetchStatusLog`, which answers without a session or CAPTCHA with the
scans, dated on Hong Kong's clock, and with an empty list for an unknown number. The e-commerce tracker reads
`/pms/v1/parcels/parcel/{number}` on api.yamatohk.com.hk with an API key that its public page gives every
visitor, and says when a number is not found. No adapter has been written for them yet.

## Links

The tracking page on app01.yamatohk.com.hk opens numbers from its `trackingNo` parameter and hands them to the
message.sg page, which takes them in `a`. The e-commerce tracker on pms.yamatohk.com.hk takes them in `track`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
