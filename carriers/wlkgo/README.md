# WLKGO

WLKGO (窝里快购, also 窝里物流), part of the Qianjiang Evening News group, is an online grocery in Hangzhou that
delivers its orders itself across the city. Its site is wlkgo.com. Tracked through the service its delivery query
page asks.

## How it works

1. `direct`: one `GET https://delivery.wlkgo.com/ajax/PackageTrack.ashx?Act=getOrderTrackInfo&orderNO={number}`.
   The page adds a JSONP callback; without one the service answers plain JSON. It needs no cookie, Referer, token
   or account. The reply echoes the number as `keywords` and lists the order's packages, each with its number,
   its carrier and its rows newest first.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest. The server is sometimes slow to accept a connection from abroad, so the
   default budget is 20 seconds.

- `result` false with a message starting 暂无包裹信息, for the number asked, is the service's answer for a number it
  holds nothing under, which is not found. Another message is inconclusive, and an answer for another number is
  refused. `result` true with no package, or a package with no row, is a number the service knows without a
  history yet; HTML is a browser check or a changed route, and a non-200 reply is a moved route or a request the
  service refuses.
- The page takes an order number or a package's. The adapter reads the package whose number was asked, else an
  order's only package; an order of several packages is inconclusive with the reason `several_parcels`.
- The page draws its form and asks the service from the number typed in, never from its address, so the catalog
  gives the page to search from and no tracking link.

## Notes

- `date` is a wall clock with no zone. It is dated on China's clock, the firm's, with `carrier` as the basis. A
  clock that would date a row after the lookup keeps its wall clock alone.
- The text names the warehouse or delivery station in brackets, such as 【杭州仓】, kept as the location.
  `statuses.json` records each text with its place as 【…】.
- `operater` and `tel` (the operator and a phone) are never read. The text names the courier and a phone when the
  parcel goes out for delivery; those, any signer or phone, and links to a picture of the signature are taken out.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Orders are SO, the date and a sequence on the sample, a shape any shop can print, so detection does not name
WLKGO, and the adapter answers explicit selection for any number of 6 to 40 letters and digits. The sample and its
source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/wlkgo` tracks the public sample, or the number in `WLKGO_TRACKING_NUMBER`,
and checks an invented order, or the one in `WLKGO_UNKNOWN_NUMBER`, reads as not found.
