# JETSPEED

JETSPEED (捷速达国际快运) is a Shenzhen forwarder.

## How it works

The tracker at `www.jetspeed-express.com/search_kuai_di/search/orderid/<number>` renders the
order's rows on the server, newest first, under the number it answers for:

1. `direct`: one GET of that page. The site's error page ("未查询到对应订单") settles not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup.

## Notes

- Rows carry wall clocks without a zone, all on the tracker's own clock in Shenzhen, wherever the
  scan was. The tracker runs on Quick Fort's platform, with the same path, notice and wordings, and
  writes its rows the same way: a row has been on the page before its wall clock came round at the
  destination or anywhere west of Asia. Each row keeps its wall clock and is dated on that clock.
- The rows follow a plan, a steady day or two apart at any hour, as Quick Fort's do. One dated after
  the lookup waits until it is due.
- Some rows name a place in the wording itself: the origin's town, the origin hub, the country of
  the airport or facility the parcel reached, the town the delivery station serves, or the station's
  own town and area before its postcode. The adapter
  reads it as the row's place, and the destination facility's country as the destination.
- Another line writes shorter rows, with the origin hub or town, or the destination's country, in
  brackets before, among or after the words; the adapter reads the brackets as the row's place. Its first
  scan is at the hub, after the order's data.
- A release that reads a row's place where an earlier one read none gives the stored row that place:
  the app's scan-identity policy lets the row with the place its wording names take over the row
  stored without one, at the same instant, so the scan is not stored twice.
- A row the map does not know is read by the shared wording rules, as on Quick Fort's tracker, so
  an answer of rows new to the map still shows the parcel moving.
- The site fails with HTTP 500 when a request accepts any language (`Accept-Language: *`, Node's
  default), so the adapter names Chinese and English.
- Universal providers do not always know these parcels, so the tracker is read directly.

## Numbers

JETSPEED's numbers have JSD and twelve digits, the shape of the example in the tracker's search
box. A high rule names JETSPEED: no other carrier writes JSD, and the parcels the app tracked in
this shape were all JETSPEED's. No public sample is known; the sample is made up in their shape.

## Links

The tracker's address carries the number in its path, and is read as a link.

## Testing

Set `JETSPEED_TRACKING_NUMBER` (and `JETSPEED_UNKNOWN_NUMBER` for the not-found answer) outside
the repository and run `npm run test:carriers:live -- carriers/jetspeed`.
