# Emirates Courier Express

Emirates Courier Express is the door-to-door express service of Emirates SkyCargo, flying
parcels point to point on Emirates aircraft from and to the United Arab Emirates, Saudi Arabia,
Bahrain, Kuwait, Oman, Qatar, South Africa, the United Kingdom, Australia, Germany and India.
Its site is emiratescx.com. Select it to read a parcel's history from the API behind the site's
tracking page.

## Numbers

Its tracking numbers are twelve digits, which the adapter takes without the spaces or dashes a
label may print. Many carriers print twelve digits, so no rule claims the shape and preflight
never asks this carrier. The public sample and its source are in [`numbers.json`](numbers.json).

## Retrieval

1. `direct`: one `GET https://api.emiratescx.com/consumer/api/Tracking/v3/EcomTracking/{number}/en-US/view-details`,
   the request the tracking-details page makes, with the site as its origin. It needs no session,
   token or check.
2. `retry`: a read that fails to reach the API, or hangs, is sent once more within the budget.
   The first try gets half of it.

- The reply lists the scans newest first, with the parcel's pieces, origin and destination. The
  pieces and each scan's piece repeat the number, which must be the whole number asked.
- A number the API holds nothing for gets HTTP 200 with every field empty and without the
  number. The GET binds the reply to the number, so it reads as not found; a reply with only some
  fields empty is a changed reply.
- A block page, even with HTTP 200, a 401 or a 403 is a challenge, a 429 a rate limit and a 503
  maintenance. A redirect, a 404 or a 410 is a moved API.
- The location drops the carrier's own name before a depot's town. The destination gives the
  destination country. A flight arrival repeated once per message about it is kept once.

## Clocks

Each scan has `d`, its wall clock where it happened, and `eventUtc`. A courier's scan writes
both for the same moment, so when they agree to the second on a whole quarter hour that the
scan's country keeps, the scan keeps its wall clock with that offset. Flight departures and
arrivals carry in `eventUtc` the time the message was written, minutes after the flight, and
keep their wall clock alone as `local_time`, which a lookup dates on the airport's clock. The
carrier is flagged `localClocks` for them.

## Statuses

Stages come from the scan's code: a milestone's three letters, or an exception group (`DLX`,
`PUX`, `SHX`, `CAX`, `CRX`, `SCX`, `LHX`) joined with the piece's reason, as `DLXREFO` for a
refusal. The codes the sample has not shown come from the tracking page's own list of code
wordings; an exception whose reason the map does not know takes its group's stage. Notices such
as a changed date or uploaded paperwork move nothing. A code the map leaves out is read by the
shared wording rules.

## Limitations

- The delivery estimate is not read: a delivered parcel's is a day after the request. While a
  parcel is on its way, the result names it as unread.
- The origin town, the pieces' references, the proof of delivery's links and the delivery
  options are left out. No weight, service, sender or recipient.
- Only a delivered parcel from the United Kingdom has been seen live; returns, customs holds and
  pickup points have not.

## Links

Tracking links carry the number as `awb_number` on the tracking-details page.

## Testing

```sh
EMIRATES_COURIER_EXPRESS_UNKNOWN_NUMBER=<made-up twelve digits> \
  npm run test:carriers:live -- carriers/emirates-courier-express
```

The live test tracks the public sample in `numbers.json`; `EMIRATES_COURIER_EXPRESS_TRACKING_NUMBER`
tracks another number.
