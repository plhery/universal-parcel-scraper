# OMG Express

OMG Express (OMG国际速运) carries parcels from its US warehouse to China: a flight to a Chinese port,
customs clearance there, then a Chinese courier to the door. Its site is omg-exp.com.

## How it works

1. `direct`: one GET of `https://omg-exp.com/tracking/<number>`, the page the site's form opens. No
   session, cookie, account or browser.
2. `retry`: the same request once more when the first fails to reach the site or hangs.

The page is rendered on the server by Next.js. The adapter reads the server data the page streams in its
scripts: the timeline component's `events`, each a time, a status code, a Chinese label, a wording and
sometimes a city. The number shows only in the page's address segment and in the list of numbers the
page displays; both must name the number asked. An unknown number gets the sentence
`没有查询到这个运单`, read as not found.

## Notes

- The scans keep their wall clock; the page gives no zone.
- The status codes carry the stage (`statuses.json`), whatever the label. `UNKNOWN`, which the page gives
  the order payment, has none.
- Once the parcel is cleared the timeline copies the Chinese courier's scans. They name the courier with a
  mobile number and list station and complaint phone numbers; all of these are left out, and station names
  stay.
- The page names the Chinese courier and its number under the waybill. The number is returned as
  `delivery_tracking_number`; the courier's name is not mapped to a carrier, because the page's label can
  differ from the courier its scans name.

## Limitations

No delivery estimate, weight, sender or recipient. The tracker also finds a recipient's parcels by phone
number, which the adapter does not take.

## Numbers

The public example is `OMG` and ten digits, from one sample only, so there is no detection rule and no
recognition: a lookup asks OMG Express only when the user picks it.

## Testing

`npm run test:carriers:live -- carriers/omg-express` reads the public sample, or
`OMG_EXPRESS_TRACKING_NUMBER`.
