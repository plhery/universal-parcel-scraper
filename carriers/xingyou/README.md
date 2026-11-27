# Xingyou International

Xingyou International (星邮国际, Shanghai Xingyou Supply Chain) runs dedicated lines and small-parcel
services for online sellers from Shanghai to North America and Europe, where local carriers such as
USPS deliver the parcels. Tracked through its tenant of the rtb56 tracking platform.

## How it works

1. `direct`: one `GET http://xygyl.rtb56.com/webservice/Service.ashx` with `method=track` and the
   number, signed as the platform's pages sign it. It needs no cookie, token, account or browser,
   and it sends no Referer: the tenant answers a bare `null` to any.
   [`../yypost/rtb56.ts`](../yypost/rtb56.ts) builds the request and reads the reply.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The company's site, xingyou-guoji.com, named this tenant for tracking; the domain no longer
  serves the company, so nothing links it. The tenant answers only plain HTTP.
- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message is inconclusive, and a 404 or a redirect is a moved route.
- A lookup sent right after another gets "The service is busy", which is inconclusive.
- Only the entry whose `server_hawbcode` is the whole number asked is read; the merchant's
  reference never is.

## Notes

- Xingyou's own rows state `+08:00`, its rows at the destination too, and the delivering
  carrier's state nothing, so rows keep their wall clocks and the result keeps the tracker's order.
- Xingyou's rows carry a code, mapped in [`statuses.json`](statuses.json); the delivering
  carrier's English scans go through the shared wording rules.
- `channel_hawbcode` is kept as the onward number once the line gives one. Places drop postcodes.
  The merchant's reference and whoever signed are not kept.

## Limitations

- No delivery estimate or weight.
- The delivering carrier is not named, so an onward number comes without a carrier.

## Numbers

The two public waybills are XY, ten digits and PQ, one from a tracking directory's Xingyou page
and one from TrackShip's, which names the company XYEX. Two samples are too few to tell the series from other carriers' numbers, so no
rule claims it and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`XINGYOU_TRACKING_NUMBER=… XINGYOU_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/xingyou`
