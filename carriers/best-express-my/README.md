# BEST Express Malaysia

BEST Express Malaysia parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Malaysia is the Malaysian parcel network of BEST Inc. It runs its own tracker at
best-inc.my, a separate site from the Vietnamese one that `best-express-vn` covers, on the
same build.

## Numbers

An archived lookup on the tracker shows a fourteen-digit waybill that starts with 6085.
BEST's Thai and Vietnamese waybills archived on their trackers have the same length and start
with their own country calling code and 85, so `best-express-my-1` suggests BEST Express
Malaysia for this prefix at low confidence: other carriers also print fourteen digits.

## Links

`best-inc.my/track?bills={number}` opens the tracker with the number filled in; the site's
tracking form builds that address, and archived lookups use it.

## Why there is no adapter

The tracker posts waybills to `www.best-inc.my/express-cc/express/expresslistinfo`.
Its gateway can answer `risk_001` before verification. The web client selects Cloudflare
Turnstile, Aliyun CAPTCHA or BEST's picture slider from its runtime configuration, and can
move to another verifier when one cannot start. Opening the page or completing a checkbox
does not establish that the gateway accepted the tracking request.

The official [BEST Express MY Android app](https://play.google.com/store/apps/details?id=com.best.android.malaysiauser)
is another endpoint lead. Its guest tracking flow uses the same lookup and BEST's picture
verification, rather than a separate tracking API.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
