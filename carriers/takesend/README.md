# Take Send

Tracks Take Send's own numbers through the lookup of its Kingtrans K5 tracker.

Take Send is 泰嘉物流 (Shenzhen Taijia Logistics), a Shenzhen consolidator founded in 2009 whose
site is takesend.com. Most of its lines hand parcels to a post or express carrier under that
carrier's number; its own numbers appear on its lines to the United States, South Africa and
the Gulf.

## How it works

The tracker at `k5.takesend.com:8180` runs on the Kingtrans K5 forwarder platform over plain
HTTP. One bounded `POST /WebTrack?action=repeat` sends the form the page sends for one number
(`index`, `billid`, `isRepeat`, `language=en`). It needs no account, cookie or CAPTCHA and
answers XML. HTTP recognition uses the same lookup.

The reply holds one `track` whose `searchBillid` must be the whole number asked. A record carries
`transbillid` and its scans as `trackitem`, newest first. A number the tracker does not know
comes back echoed alone, without `transbillid` or scans; that echo is not found.

## Notes

Take Send's scans in China keep Beijing's wall clock. Its scans placed at another country's code,
from the flight's last stop to the destination's import clearance, keep that place's: read on
Beijing's, a parcel landed in the United States four hours after its last stop in Hong Kong, and
customs worked through the night. A country with one clock dates them; the United States' wall
clock is left to the shared clock stage, which dates it on the destination's. Take Send writes its
own name in the place column of its distribution-centre scans, which is no place, so those scans
have no location. Scans are staged by their wording; a scan the map does not know takes the wording
classifier, and a record without one takes its `trackstatus` code, whose labels come from the
page's script.

On the line to the United States, `transbillid` is YWE's number. A partner's number in
`transbillid` or `billid` is named as the delivery partner only when that partner's own rules
claim it whole at high confidence.

## Numbers

`TS` and thirteen digits, which begin with the date the parcel was registered. Take Send's
weekly delivery-time posts print them with most digits hidden, and no public page shows a whole
number, so the corpus holds a made-up number in that layout. HTTP recognition asks only for
numbers in that dated layout.

## Links

The tracker's `WebTrack?action=list&bills=` opens one number. It is plain HTTP, so the catalog
gives no portal link that would carry the number unencrypted.

## Live test

Set `TAKESEND_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/takesend/adapter.live.test.ts`.
Optionally set `TAKESEND_UNKNOWN_NUMBER` to check the not-found echo.
