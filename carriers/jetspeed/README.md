# JETSPEED

JETSPEED (捷速达国际快运) is a Shenzhen forwarder.

## How it works

The tracker at `www.jetspeed-express.com/search_kuai_di/search/orderid/<number>` renders the
order's rows on the server, newest first, under the number it answers for:

1. `direct`: one GET of that page. The site's error page ("未查询到对应订单") settles not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup.

## Notes

- Rows carry wall clocks without a zone, written where the parcel was: at its origin, which can be
  abroad, and at its destination. Each keeps its wall clock.
- Some rows name a place in the wording itself: the origin's town, the origin hub, the country of
  the airport or facility the parcel reached, the town the delivery station serves. The adapter
  reads it as the row's place, so a lookup dates the rows on that place's clock rather than the
  carrier's home clock, and the destination facility's country as the destination.
- The site fails with HTTP 500 when a request accepts any language (`Accept-Language: *`, Node's
  default), so the adapter names Chinese and English.
- Universal providers do not always know these parcels, so the tracker is read directly.

## Numbers

JETSPEED's numbers have JSD and twelve digits, the shape of the example in the tracker's search
box. A low rule offers JETSPEED for it, and recognition confirms the number. No public sample is
known; the sample is made up in the shape of parcels the app tracked.

## Links

The tracker's address carries the number in its path, and is read as a link.

## Testing

Set `JETSPEED_TRACKING_NUMBER` (and `JETSPEED_UNKNOWN_NUMBER` for the not-found answer) outside
the repository and run `npm run test:carriers:live -- carriers/jetspeed`.
