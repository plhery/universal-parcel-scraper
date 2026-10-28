# YDH

YDH parcels use enabled universal providers. There is no dedicated adapter.

YDH is 义达跨境 (YDH Cross border (Shanghai) Logistics), a Shanghai forwarder that began with a
line from China to Japan and now runs direct parcel lines to Japan, the United States and Europe.
Its site is ydhex.com.

## Numbers

YDH's numbers are `YDH`, ten digits and two letters, `YQ` or `AZ` so far. Three public examples
are answered by YDH's own tracker, so `ydh-1` has high confidence. The partner that delivers a
parcel abroad gives it its own number, which the tracker shows beside YDH's.

## Tracker

The tracker at track.ydhex.com runs on the rtb56 forwarder platform that
[YYpost's adapter](../yypost/README.md) reads. It answers the platform's JSONP interface without
a cookie, key or CAPTCHA, so a dedicated adapter can use the shared client. Its scans in the
United States all carry a GMT-08:00 offset whatever the season, so their offsets cannot be
trusted.

## Links

The tracker's `track_query.aspx?track_number=` opens one number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
