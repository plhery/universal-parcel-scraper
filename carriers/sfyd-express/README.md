# SFYD Express

SFYD Express (云速递) runs air freight lines for online sellers from Shenzhen and Yiwu to Europe,
North America, Southeast Asia and the Middle East, where local carriers such as USPS deliver the
parcels. Tracked through its tenant of the rtb56 tracking platform.

## How it works

1. `direct`: one `GET http://sfyd.rtb56.com/webservice/Service.ashx` with `method=track` and the
   number, signed as the platform's pages sign it. It needs no cookie, token, account or browser.
   [`../yypost/rtb56.ts`](../yypost/rtb56.ts) builds the request and reads the reply.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The tracking page on sfydexpress.com asks `/fetch_track.php`, which relays the same lookup but
  answers an unknown number and a failed lookup alike, with `"success":false`. The tenant's own
  lookup tells them apart, so the adapter asks it, over plain HTTP, the only scheme it answers.
- A number with no waybill is HTTP 200 with `"success":0` and "No query to track information",
  which is not found. Any other message is inconclusive, and a 404 or a redirect is a moved route.
- Only the entry whose `server_hawbcode` is the whole number asked is read; the merchant's
  reference never is.

## Notes

- SFYD's own scans state `+08:00` and get their instants; the delivering carrier's scans state no
  offset and keep their wall clocks, so the result keeps the tracker's order.
- The first scans carry a code (`IR`, `AF`, `DF`); later ones come in English without one. Both
  are mapped in [`statuses.json`](statuses.json) where the shared wording rules miss them.
- `channel_hawbcode` is kept as the onward number once the line gives one. Places drop postcodes.
  The merchant's reference and whoever signed are not kept.

## Limitations

- No delivery estimate or weight.
- The delivering carrier is not named, so an onward number comes without a carrier.

## Numbers

The only public waybill is SFYD and eleven digits. One sample is too few to tell its series from
other carriers' numbers, so no rule claims it and the adapter answers explicit selection. The
sample and its source are in [`numbers.json`](numbers.json).

## Testing

`SFYD_EXPRESS_TRACKING_NUMBER=SFYD26099215028 SFYD_EXPRESS_UNKNOWN_NUMBER=SFYD00000000000 npm run test:carriers:live -- carriers/sfyd-express`
