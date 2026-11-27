# GOOD Express

GOOD Express (GOOD快递, goodkuaidi.com) carries parcels from its depots in the United States to
China, clears them through Chinese customs and hands them to a courier in China. Tracked through
the TrackingInfo page of its site.

## How it works

1. `direct`: one `GET https://www.goodkuaidi.com/TrackingInfo?TrackginNO={number}`, the
   parameter spelled so. The site links the page over plain HTTP; HTTPS serves the same page, so
   the number never travels in the clear. The page renders the rows on the server: no cookie,
   form state, CAPTCHA or browser is needed.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the
   budget.

Recognition asks the same page.

- Only the waybill whose number is the whole number asked is read; a page for another number is
  indeterminate.
- A number the tracker does not know gets HTTP 200 and one row, "无跟踪信息", stamped with the
  moment of the lookup. Only that answer is not found. A redirect or an error status is a moved
  route, a bot check is a challenge, and any other page is a schema failure.
- [`trackingInfo.ts`](trackingInfo.ts) reads the waybill and its rows. Longteng's tracker runs on
  the same platform and shares it; each site keeps its own wording, clock and hand-off.

## Notes

- Rows are instants on China time, the rows in the United States too: the not-found row carries
  the moment of the lookup on China's clock, and a parcel's newest rows come just before it.
  Month, day and hour come without their leading zero.
- GOOD's own rows are Chinese with English in 【】, and open with the country in 【】, which
  becomes the location; the whole row stays as the original description. Once the courier in
  China takes the parcel, its rows follow in Chinese only.
- The hand-off row names the courier and its number. The number becomes the delivery tracking
  number, and SF Express the delivery carrier when the row names 顺丰速运 and SF's rules offer
  the number.
- [`status.ts`](status.ts) stages GOOD's rows and SF Express's depot rows by their wording; other
  wording goes through the shared rules. The request to upload the recipient's identity card
  moves nothing. The newest row with a stage decides.

## Limitations

- No public sample shows a delivery. It comes through the courier's rows, which GOOD relays in
  Chinese. The catalog's SF Express and China EMS maps hold no Chinese wording to cite, so the
  carrier's map leaves the couriers' delivery and out-for-delivery wordings to the shared rules,
  which read 已签收 as delivered.
- The tracker forgets a waybill some time after its journey; older public samples answer as
  unknown.
- The page also finds parcels by the recipient's phone number, and takes up to ten numbers at a
  time; the adapter asks one waybill.
- No delivery estimate, weight or service.

## Numbers

GOOD's waybills are GD, eleven digits and US, as its identity-card upload form shows. No other
carrier's rule takes the shape, but two letters say little, so the rule is low and recognition
asks the tracker. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.goodkuaidi.com/TrackingInfo?TrackginNO={number}` opens one waybill on the tracker. The search
page is the home page, with its tracking box, and the help link is the site's contact page.

## Testing

`npm run test:carriers:live -- carriers/good-express-us`, with `GOOD_EXPRESS_TRACKING_NUMBER`
and optionally `GOOD_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
