# BEST Express Vietnam

BEST Express Vietnam parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Vietnam is the Vietnamese parcel network of BEST Inc. It runs its own tracker at
best-inc.vn; `best-transport` is an unrelated Scandinavian carrier.

## Numbers

Archived lookups on the tracker show fourteen-digit waybills and, once, TK followed by nine
digits. Fourteen digits are shared with DPD and other carriers, and a single TK lookup does not
establish a family, so no rule names BEST Express Vietnam.

## Links

`best-inc.vn/track?bills={number}` opens the tracker with the number filled in, the address
archived lookups use; the tracker script also reads `waybill`.

## Why there is no adapter

The tracker posts waybills to `www.best-inc.vn/express-cc/express/expresslistinfoWithPhone`,
or `expresslistinfo` without its phone step. Its gateway can answer `risk_001` before BEST's
picture verification, which rotates an image upright. A later `notMatchCodeList` response
can require recipient phone completion; that input is separate from CAPTCHA verification.

The official [BEST Express VN Android app](https://play.google.com/store/apps/details?id=com.best.android.vietuser)
uses the same guest lookup and BEST verification parameters, rather than a separate tracking
API.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
